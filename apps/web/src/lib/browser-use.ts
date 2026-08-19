import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import sharp from 'sharp'
import { z } from 'zod'
import puppeteer, { type Browser, type ElementHandle, type Page } from 'puppeteer-core'
import { ABILITY_FRAME_KEY, defineAbility, describeThrown, type Ability, type AbilityFrame } from '@bunkhouse/runtime'
import { createDeskFrameDeduplicator, type DeskFrameDeduplicator } from '@braedonsaunders/appkit-desk'
import { deskEvents, deskSessions, people, type DeskLedgerEventDetail, type DeskLedgerEventKind } from '../db/schema'
import { db } from '../db/client'
import { saveFile } from './files'
import { assertPublicHost } from './research'
import { AGENT_SCREEN_HEIGHT, AGENT_SCREEN_WIDTH } from './agent-screen'
import { GUEST_DOWNLOADS_DIR, connectDeskBrowser, deskSupported, recordDeskLedgerEvent } from './desk'
import {
  browserCastWanted,
  installAgentCursor,
  leadCursorTo,
  startBrowserCast,
  CURSOR_HOST_ATTR,
  type BrowserCast,
} from './browser-cast'

/**
 * The agent's browser — running INSIDE its desk. The driver logic here is
 * unchanged in spirit (target by visible text, verify typing, record every
 * step), but the Chromium it drives lives in the agent's own microVM with a
 * PERSISTENT profile in the guest home: sign in once and the login survives
 * into the next run, and a downloaded file lands where run_shell can process
 * it. Puppeteer connects over the desk-runner's
 * CDP relay rather than launching a process.
 *
 * Doctrine: gated abilities are recorded. Every step screenshots the viewport,
 * files it in the files ledger, and appends a desk_events row on the run's ONE
 * desk session — the browser shares the ledger with the shell and the screen
 * (§3.19), so an operator replays the whole piece of work in order, not three
 * tables interleaved by timestamp. Recording is not optional — a step that
 * cannot be recorded is still written to the ledger with the reason its frame
 * is missing.
 *
 * The agent sees what it is doing. The same frame, resized for a model, comes
 * back with the step under the runtime's frame key, so the model gets both the
 * page as structure (text, links, fields) and the page as pixels. An agent
 * given only extracted text navigates a widget it cannot see, is told every
 * keystroke succeeded, and reports on results it never actually got; a picture
 * is what makes "the field did not change" observable.
 *
 * On a call, somebody is watching. The same page is streamed into the caller's
 * room as live video (browser-cast.ts) with a pointer drawn into it, so they
 * watch the agent work rather than flipping through the stills afterwards.
 * That is a view, not a record: the ledger below is unchanged and remains the
 * evidence. A run with nobody on the line opens no cast and behaves exactly as
 * it always has.
 *
 * Nothing here reports success it did not verify: typing reads the field's
 * value back out of the DOM and fails loudly when the field ignored it, which
 * is what a date picker or a read-only input does to typed text.
 *
 * Discipline, all enforced here rather than in prompts:
 *   · one browser per employee microVM, with every step appended to the run's
 *     one Desk session and counted against the same run-scoped step budget;
 *   · a hard step budget per session;
 *   · http(s) only, and every top-level navigation — including each redirect
 *     hop — passes the same public-host check the research fetcher uses;
 *   · downloads denied; the browser writes nothing to disk.
 */

type PersonRow = typeof people.$inferSelect

const MAX_STEPS = 40
const NAVIGATION_TIMEOUT_MS = 90_000
const ACTION_TIMEOUT_MS = 30_000
/** Grace given to a click/Enter that turns out to navigate. */
const NAVIGATION_GRACE_MS = 5_000
const SETTLE_IDLE_MS = 700
const SETTLE_TIMEOUT_MS = 15_000
const IDLE_CLOSE_MS = 180_000
/**
 * One size for the browser and for the live video of it, so a frame published
 * to a call is the page pixel for pixel and nothing is ever rescaled on the
 * way. The number lives with the track contract, in agent-screen.
 */
const VIEWPORT = { width: AGENT_SCREEN_WIDTH, height: AGENT_SCREEN_HEIGHT }
const SCREENSHOT_QUALITY = 60
/**
 * The frame the model is shown is a resized copy of the filed one: every
 * vision model downscales its input anyway, and a full-size JPEG per step
 * would spend the run's context on pixels it never uses. The archived
 * evidence stays at full viewport quality.
 */
const MODEL_FRAME_WIDTH = 1024
const MODEL_FRAME_QUALITY = 55
/** Second pass when a busy page still encodes large. */
const MODEL_FRAME_FALLBACK_WIDTH = 800
const MODEL_FRAME_FALLBACK_QUALITY = 40
/** Hard ceiling on the bytes put in front of a model, before base-64. */
const MODEL_FRAME_MAX_BYTES = 200_000
const PAGE_TEXT_CAP = 8000
const LINK_CAP = 30
const FIELD_CAP = 30
/** Marker the page-side finders leave on the element an action will target. */
const TARGET_ATTR = 'data-bunkhouse-target'

/**
 * Fail-closed capability detection: the browser lives in the desk now, so a
 * deployment with no desk runner has no browser at all — the abilities are
 * withheld entirely, exactly as they were without a local Chromium.
 */
export function browserSupported(): boolean {
  return deskSupported()
}

// ---------------------------------------------------------------------------
// Page reading — everything the agent gets back after an action
// ---------------------------------------------------------------------------

/**
 * page.evaluate ships a function's compiled SOURCE to Chromium, and the worker
 * runs through tsx/esbuild, which wraps every named inner function in a
 * `__name` helper that exists only in the Node bundle. Defining an identity
 * `__name` in the page keeps those bodies runnable there. Written as a source
 * string so this shim itself can never depend on a compiler helper.
 */
const NAME_SHIM = 'globalThis.__name = globalThis.__name || function (fn) { return fn }'

async function shimPage(page: Page): Promise<void> {
  await page.evaluate(NAME_SHIM)
}

export type PageSummary = {
  url: string
  title: string
  text: string
  truncated: boolean
  links: { text: string; url: string }[]
  inputs: { label: string; type: string }[]
}

/**
 * Reduce the live page to what an agent can act on: readable text (the same
 * main/article/body preference readWebpage uses, taken from the rendered DOM
 * instead of raw HTML), the links it can click, the fields it can type into.
 */
async function summarizePage(page: Page): Promise<PageSummary> {
  await shimPage(page)
  return page.evaluate(
    (caps: { text: number; links: number; fields: number }) => {
      const clean = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim()
      const visible = (element: Element): boolean => {
        const style = window.getComputedStyle(element)
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false
        return element.getClientRects().length > 0
      }

      const region = document.querySelector('main') ?? document.querySelector('article') ?? document.body
      const body =
        region instanceof HTMLElement ? region.innerText : (region as Element | null)?.textContent ?? ''
      const text = body
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()

      const links: { text: string; url: string }[] = []
      const seen = new Set<string>()
      for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
        if (links.length >= caps.links) break
        if (!visible(anchor)) continue
        const label = clean(anchor.textContent)
        const url = (anchor as HTMLAnchorElement).href
        if (!label || !(url.startsWith('http://') || url.startsWith('https://'))) continue
        const key = `${label}\u0000${url}`
        if (seen.has(key)) continue
        seen.add(key)
        links.push({ text: label.slice(0, 120), url })
      }

      const inputs: { label: string; type: string }[] = []
      for (const field of Array.from(
        document.querySelectorAll('input, textarea, select, [contenteditable="true"]'),
      )) {
        if (inputs.length >= caps.fields) break
        if (!visible(field)) continue
        const type =
          field.getAttribute('contenteditable') === 'true'
            ? 'editable'
            : field instanceof HTMLInputElement
              ? field.type || 'text'
              : field.tagName.toLowerCase()
        if (type === 'hidden') continue
        const fieldId = field.getAttribute('id')
        const explicit = fieldId ? document.querySelector(`label[for="${CSS.escape(fieldId)}"]`) : null
        const label =
          clean(explicit?.textContent) ||
          clean(field.closest('label')?.textContent) ||
          clean(field.getAttribute('aria-label')) ||
          clean(field.getAttribute('placeholder')) ||
          clean(field.getAttribute('name')) ||
          clean(fieldId)
        if (!label) continue
        inputs.push({ label: label.slice(0, 120), type })
      }

      return {
        url: window.location.href,
        title: document.title,
        text: text.slice(0, caps.text),
        truncated: text.length > caps.text,
        links,
        inputs,
      }
    },
    { text: PAGE_TEXT_CAP, links: LINK_CAP, fields: FIELD_CAP },
  )
}

/** Wait for the page to stop talking to the network, without ever hanging. */
async function settle(page: Page): Promise<void> {
  await page.waitForNetworkIdle({ idleTime: SETTLE_IDLE_MS, timeout: SETTLE_TIMEOUT_MS }).catch(() => {})
}

/** A click or Enter may or may not navigate; give it a grace period, then settle. */
async function settleAfterInteraction(page: Page): Promise<void> {
  const navigated = page
    .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_GRACE_MS })
    .catch(() => null)
  await navigated
  await settle(page)
}

// ---------------------------------------------------------------------------
// Targeting — exact visible text first, CSS selector second
// ---------------------------------------------------------------------------

type TargetMatch = { found: true; label: string; type: string } | { found: false; candidates: string[] }

/** Mark the clickable element the agent named, and report what was matched. */
async function markClickable(page: Page, target: string): Promise<TargetMatch> {
  await shimPage(page)
  return page.evaluate(
    (args: { target: string; attr: string; cursor: string }): TargetMatch => {
      const clean = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim()
      const visible = (element: Element): boolean => {
        const style = window.getComputedStyle(element)
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false
        return element.getClientRects().length > 0
      }
      const labelOf = (element: Element): string =>
        clean(
          element instanceof HTMLInputElement
            ? element.value || element.getAttribute('aria-label')
            : element.textContent || element.getAttribute('aria-label') || element.getAttribute('title'),
        )

      for (const marked of Array.from(document.querySelectorAll(`[${args.attr}]`))) {
        marked.removeAttribute(args.attr)
      }

      const clickable = Array.from(
        document.querySelectorAll(
          'a[href], button, summary, input[type="submit"], input[type="button"], input[type="reset"], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"]',
        ),
      ).filter(visible)

      const wanted = clean(args.target).toLowerCase()
      let match =
        clickable.find((element) => labelOf(element).toLowerCase() === wanted) ??
        clickable.find((element) => labelOf(element).toLowerCase().includes(wanted)) ??
        null
      if (!match) {
        try {
          const bySelector = document.querySelector(args.target)
          // The pointer drawn for a live viewer is not page content: a loose
          // selector ("div") must never resolve to it, and the agent must
          // never click its own cursor.
          if (bySelector && visible(bySelector) && !bySelector.closest(`[${args.cursor}]`)) {
            match = bySelector
          }
        } catch {
          // Not a valid CSS selector — it was only ever meant as visible text.
        }
      }
      if (!match) {
        const candidates: string[] = []
        for (const element of clickable) {
          const label = labelOf(element)
          if (label && !candidates.includes(label)) candidates.push(label.slice(0, 80))
          if (candidates.length >= 20) break
        }
        return { found: false, candidates }
      }
      match.setAttribute(args.attr, '1')
      // The agent works one page; a link that would open a tab opens in place.
      if (match.getAttribute('target')) match.setAttribute('target', '_self')
      return {
        found: true,
        label: labelOf(match).slice(0, 120) || args.target,
        type: match.tagName.toLowerCase(),
      }
    },
    { target, attr: TARGET_ATTR, cursor: CURSOR_HOST_ATTR },
  )
}

/** Mark the form field the agent named — by label, aria-label, placeholder, name, id, or selector. */
async function markField(page: Page, target: string): Promise<TargetMatch> {
  await shimPage(page)
  return page.evaluate(
    (args: { target: string; attr: string; cursor: string }): TargetMatch => {
      const clean = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim()
      const visible = (element: Element): boolean => {
        const style = window.getComputedStyle(element)
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false
        return element.getClientRects().length > 0
      }
      const typeOf = (element: Element): string =>
        element.getAttribute('contenteditable') === 'true'
          ? 'editable'
          : element instanceof HTMLInputElement
            ? element.type || 'text'
            : element.tagName.toLowerCase()
      const namesOf = (element: Element): string[] => {
        const fieldId = element.getAttribute('id')
        const explicit = fieldId ? document.querySelector(`label[for="${CSS.escape(fieldId)}"]`) : null
        return [
          clean(explicit?.textContent),
          clean(element.closest('label')?.textContent),
          clean(element.getAttribute('aria-label')),
          clean(element.getAttribute('placeholder')),
          clean(element.getAttribute('name')),
          clean(fieldId),
        ].filter((name) => name.length > 0)
      }

      for (const marked of Array.from(document.querySelectorAll(`[${args.attr}]`))) {
        marked.removeAttribute(args.attr)
      }

      const fields = Array.from(
        document.querySelectorAll('input, textarea, select, [contenteditable="true"]'),
      ).filter((element) => visible(element) && typeOf(element) !== 'hidden')

      const wanted = clean(args.target).toLowerCase()
      let match =
        fields.find((element) => namesOf(element).some((name) => name.toLowerCase() === wanted)) ??
        fields.find((element) => namesOf(element).some((name) => name.toLowerCase().includes(wanted))) ??
        null
      if (!match) {
        try {
          const bySelector = document.querySelector(args.target)
          // Never the drawn pointer — see markClickable.
          if (bySelector && visible(bySelector) && !bySelector.closest(`[${args.cursor}]`)) {
            match = bySelector
          }
        } catch {
          // Not a valid CSS selector — it was only ever meant as a field label.
        }
      }
      if (!match) {
        const candidates: string[] = []
        for (const element of fields) {
          const name = namesOf(element)[0]
          if (name && !candidates.includes(name)) candidates.push(name.slice(0, 80))
          if (candidates.length >= 20) break
        }
        return { found: false, candidates }
      }
      match.setAttribute(args.attr, '1')
      return { found: true, label: namesOf(match)[0]?.slice(0, 120) ?? args.target, type: typeOf(match) }
    },
    { target, attr: TARGET_ATTR, cursor: CURSOR_HOST_ATTR },
  )
}

async function markedHandle(page: Page): Promise<ElementHandle<Element> | null> {
  return page.$(`[${TARGET_ATTR}]`)
}

/**
 * Walk the drawn pointer onto the element an action is about to land on.
 *
 * The browser tools target by element, never by coordinate, so nothing about
 * an action moves a pointer on its own — puppeteer's own mouse jumps to the
 * element and clicks in the same instant. A viewer watching that sees results
 * with no intent behind them. This is the intent: a fifth of a second of
 * easing, and the page scrolled smoothly if the target was off-screen.
 *
 * Nothing else waits on it. When no one is watching there is no cast, and this
 * returns without a round trip to the page; when someone is, a pointer that
 * cannot move, a target that moved away, or a page that is not painting all
 * resolve the same way — quietly, on time, with the real action next.
 */
async function leadCursor(session: LiveSession): Promise<void> {
  if (!session.cast) return
  await leadCursorTo(session.page, TARGET_ATTR)
}

/** What a field actually says, and whether it was ever going to take typing. */
type FieldState = {
  /** The field's current value, whitespace-collapsed. */
  value: string
  /** The field refuses typed text by declaration — a read-only input. */
  readOnly: boolean
  disabled: boolean
}

/**
 * Read the marked field's value straight out of the DOM. This is the check
 * that makes typing honest: puppeteer reports success for keystrokes a page
 * simply ignored, and a date picker or a read-only input ignores every one of
 * them while the ledger fills with "typed successfully".
 */
async function readMarkedField(page: Page): Promise<FieldState | null> {
  await shimPage(page)
  return page.evaluate((attr: string): FieldState | null => {
    const element = document.querySelector(`[${attr}]`)
    if (!element) return null
    const raw =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? element.value
        : element instanceof HTMLElement
          ? element.innerText
          : (element.textContent ?? '')
    return {
      value: (raw ?? '').replace(/\s+/g, ' ').trim(),
      readOnly:
        (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.readOnly,
      disabled:
        (element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement) &&
        element.disabled,
    }
  }, TARGET_ATTR)
}

/**
 * The same read, after an action that may have re-rendered the field out from
 * under its marker — React and friends replace nodes freely. Re-finding it by
 * the agent's own target uses exactly the rules that found it the first time.
 */
async function readFieldAgain(page: Page, target: string): Promise<FieldState | null> {
  const direct = await readMarkedField(page)
  if (direct) return direct
  const rematched = await markField(page, target)
  if (!rematched.found) return null
  return readMarkedField(page)
}

// ---------------------------------------------------------------------------
// Session lifecycle — one live browser per run, reaped when idle
// ---------------------------------------------------------------------------

type LiveSession = {
  tenantId: string
  personId: string
  runId: string
  browser: Browser
  page: Page
  /** Browser steps already spent this run — the §3.18 budget counter. */
  seq: number
  idle: ReturnType<typeof setTimeout> | null
  /** Last navigation the guard refused, so a failed goto can say why. */
  blocked: string | null
  /**
   * The live video of this page, when somebody is watching it — a caller on
   * the line. Null on every other run, and then this session behaves exactly
   * as it always has: no cursor, no screencast, no added latency.
   */
  cast: BrowserCast | null
  frameDeduplicator: DeskFrameDeduplicator
  lastScreenshotFileId: string | null
}

type SessionRuntime = typeof globalThis & { __bunkhouseBrowserSessions?: Map<string, Promise<LiveSession>> }
const sessionRuntime = globalThis as SessionRuntime

// Next hot-reloads module graphs in dev; the live-session map lives on
// globalThis so a reload never orphans a running Chromium.
function liveSessions(): Map<string, Promise<LiveSession>> {
  return (sessionRuntime.__bunkhouseBrowserSessions ??= new Map())
}

function touch(session: LiveSession): void {
  if (session.idle) clearTimeout(session.idle)
  const timer = setTimeout(() => {
    void closeBrowserSession(session.runId)
  }, IDLE_CLOSE_MS)
  if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  session.idle = timer
}

/** The verbs this driver writes, as they land on the desk ledger. */
const BROWSER_EVENT_KINDS = ['navigate', 'click', 'type', 'read', 'screenshot', 'browser_close'] as const

const STEP_KIND: Record<string, DeskLedgerEventKind> = {
  open: 'navigate',
  click: 'click',
  type: 'type',
  read: 'read',
  screenshot: 'screenshot',
  close: 'browser_close',
}

/**
 * Browser steps already on the run's desk session — what makes the step
 * budget survive an idle-reaped session reopening onto the same run.
 */
async function browserStepsSoFar(tenantId: string, runId: string): Promise<number> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [session] = await app.db
      .select({ id: deskSessions.id })
      .from(deskSessions)
      .where(and(eq(deskSessions.tenantId, tenantId), eq(deskSessions.runId, runId)))
    if (!session) return 0
    const [row] = await app.db
      .select({ count: sql<number>`count(*)::int` })
      .from(deskEvents)
      .where(
        and(
          eq(deskEvents.tenantId, tenantId),
          eq(deskEvents.sessionId, session.id),
          inArray(deskEvents.kind, [...BROWSER_EVENT_KINDS]),
        ),
      )
    return row?.count ?? 0
  })
}

async function openSession(args: { tenantId: string; person: PersonRow; runId: string }): Promise<LiveSession> {
  if (!deskSupported()) throw new Error('No desk is configured, so there is no browser.')
  const spent = await browserStepsSoFar(args.tenantId, args.runId)

  // The browser is the desk's: the runner ensures in-guest Chromium is up
  // (headless, persistent profile in the guest home) and relays CDP; this
  // process only ever CONNECTS. Closing here disconnects — the browser and
  // its logins stay warm on the machine.
  const { browserWSEndpoint } = await connectDeskBrowser({
    tenantId: args.tenantId,
    personId: args.person.id,
  })

  const browser = await puppeteer.connect({ browserWSEndpoint })
  try {
    const page = await browser.newPage()
    const session: LiveSession = {
      tenantId: args.tenantId,
      personId: args.person.id,
      runId: args.runId,
      browser,
      page,
      seq: spent,
      idle: null,
      blocked: null,
      cast: null,
      frameDeduplicator: createDeskFrameDeduplicator(),
      lastScreenshotFileId: null,
    }

    await page.setViewport(VIEWPORT)
    await page.setJavaScriptEnabled(true)
    page.setDefaultTimeout(ACTION_TIMEOUT_MS)
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)
    const userAgent = await browser.userAgent()
    await page.setUserAgent(`${userAgent.replace('HeadlessChrome', 'Chrome')} BunkhouseAgent/1.0`)
    await page.evaluateOnNewDocument(NAME_SHIM)

    // One page per session: a window a site opens for itself is closed rather
    // than left running unseen and unrecorded behind the agent's back.
    page.on('popup', (popup) => {
      void popup?.close().catch(() => {})
    })

    // Downloads land in the GUEST's downloads folder — a real filesystem the
    // agent owns, visible to run_shell and list_workspace_files. This is the
    // path between the browser and the shell that never existed before the
    // desk (Phase 4); the old driver denied downloads because it had nowhere
    // safe to put them.
    const cdp = await page.createCDPSession()
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: GUEST_DOWNLOADS_DIR })

    // Every top-level navigation — including each redirect hop, which is where
    // an SSRF actually lands — is checked before Chromium is allowed to make it.
    await page.setRequestInterception(true)
    page.on('request', (request) => {
      void (async () => {
        const raw = request.url()
        if (raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('about:')) {
          await request.continue().catch(() => {})
          return
        }
        let parsed: URL | null = null
        try {
          parsed = new URL(raw)
        } catch {
          parsed = null
        }
        if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
          session.blocked = `${raw.slice(0, 200)} — only http(s) pages can be opened.`
          await request.abort('blockedbyclient').catch(() => {})
          return
        }
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          const refusal = await assertPublicHost(parsed).then(
            () => null,
            (error: unknown) => describeThrown(error),
          )
          if (refusal) {
            session.blocked = `${parsed.host} — ${refusal}`
            await request.abort('blockedbyclient').catch(() => {})
            return
          }
        }
        await request.continue().catch(() => {})
      })()
    })

    // Somebody on a call is waiting to watch this: draw a pointer into the
    // page — a devtools mouse paints nothing — and start streaming the page
    // itself into their room. Both are best-effort by construction. A browser
    // session is the agent's working tool first; it opens whether or not the
    // picture of it can be sent, and the reason goes in the log where an
    // operator can act on it.
    if (browserCastWanted(args.runId)) {
      try {
        await installAgentCursor(page)
        session.cast = await startBrowserCast({ page, runId: args.runId })
      } catch (error) {
        console.error(
          `[browser] run ${args.runId}: the live view of this browser could not be started — ${describeThrown(error)}`,
        )
      }
    }

    return session
  } catch (error) {
    // The connection is ours; the browser is the desk's. Never close it here.
    browser.disconnect()
    throw error
  }
}

async function getSession(args: {
  tenantId: string
  person: PersonRow
  runId: string
}): Promise<LiveSession> {
  const map = liveSessions()
  const pending = map.get(args.runId)
  if (pending) {
    const existing = await pending.catch(() => null)
    if (existing && existing.browser.connected && !existing.page.isClosed()) {
      touch(existing)
      return existing
    }
    map.delete(args.runId)
  }
  const started = openSession(args)
  map.set(args.runId, started)
  try {
    const session = await started
    touch(session)
    return session
  } catch (error) {
    map.delete(args.runId)
    throw error
  }
}

/**
 * End the run's browser involvement: close our page and DISCONNECT. The
 * in-guest Chromium keeps running with its persistent profile — logins
 * survive into the next run, which is the whole point of Phase 4. The desk
 * session row itself is stamped by closeDeskSession at run teardown, because
 * the shell may still be working after the browser is done. Idempotent — the
 * run teardown, the agent's own browser_close, and the idle reaper all land
 * here.
 */
export async function closeBrowserSession(runId: string): Promise<void> {
  const map = liveSessions()
  const pending = map.get(runId)
  if (!pending) return
  map.delete(runId)
  const session = await pending.catch(() => null)
  if (!session) return
  if (session.idle) clearTimeout(session.idle)
  session.idle = null
  // Stopped before the page goes: the screencast holds a CDP session on it,
  // and the published track must come down with the browser rather than leave
  // the caller staring at a frozen last frame of a browser that is gone.
  await session.cast?.stop()
  session.cast = null
  await session.page.close().catch(() => {})
  session.browser.disconnect()
}

// ---------------------------------------------------------------------------
// Recording — every step leaves a frame and a ledger row
// ---------------------------------------------------------------------------

/** The frame a step captured, in both the sizes it is wanted at. */
type StepRecord = {
  seq: number
  /** The full-size frame in the files ledger — the operator's evidence. */
  fileId: string | null
  /** Why there is no filed frame, when there is none. */
  recordingError: string | null
  /** The same view, resized for a model to look at. */
  frame: { mediaType: string; data: string } | null
  /** Why the agent has no picture of this step, when it has none. */
  frameError: string | null
  /** The captured pixels exactly match the preceding filed frame. */
  frameRepeated: boolean
}

/**
 * Shrink a captured frame to something a model can be handed cheaply. Two
 * passes, then give up: a picture too large to send is reported as a missing
 * picture rather than quietly spending the run's whole context on one step.
 */
async function frameForModel(bytes: Uint8Array): Promise<Buffer | null> {
  const encode = (width: number, quality: number) =>
    sharp(Buffer.from(bytes)).resize({ width, withoutEnlargement: true }).jpeg({ quality }).toBuffer()
  const first = await encode(MODEL_FRAME_WIDTH, MODEL_FRAME_QUALITY)
  if (first.byteLength <= MODEL_FRAME_MAX_BYTES) return first
  const second = await encode(MODEL_FRAME_FALLBACK_WIDTH, MODEL_FRAME_FALLBACK_QUALITY)
  return second.byteLength <= MODEL_FRAME_MAX_BYTES ? second : null
}

async function recordStep(
  session: LiveSession,
  action: string,
  detail: DeskLedgerEventDetail,
  options: { show?: boolean } = {},
): Promise<StepRecord> {
  const seq = session.seq + 1
  session.seq = seq
  const recorded: DeskLedgerEventDetail = { ...detail }
  let screenshotFileId: string | null = null
  let captured: Uint8Array | null = null
  let modelFrame: { mediaType: string; data: string } | null = null
  let frameError: string | null = null
  let frameRepeated = false
  try {
    captured = await session.page.screenshot({ type: 'jpeg', quality: SCREENSHOT_QUALITY })
  } catch (error) {
    recorded.screenshotError = `The screen could not be captured: ${describeThrown(error)}`
    frameError = recorded.screenshotError
  }
  if (captured) {
    const identity = session.frameDeduplicator.observe(captured, 'image/jpeg')
    recorded.frameId = identity.frameId
    recorded.frameRepeated = !identity.changed
    frameRepeated = !identity.changed
    try {
      if (identity.changed) {
        const file = await saveFile({
          tenantId: session.tenantId,
          personId: session.personId,
          runId: session.runId,
          kind: 'recording',
          filename: `browser-step-${String(seq).padStart(3, '0')}.jpg`,
          contentType: 'image/jpeg',
          bytes: captured,
        })
        screenshotFileId = file.id
        session.lastScreenshotFileId = file.id
      } else {
        screenshotFileId = session.lastScreenshotFileId
      }
    } catch (error) {
      recorded.screenshotError = `The frame could not be filed: ${describeThrown(error)}`
    }
    // Filing and seeing are independent: a frame that could not be stored is
    // still one the agent should look at, and the other way round.
    if (options.show !== false && identity.changed) {
      try {
        const shrunk = await frameForModel(captured)
        if (shrunk) modelFrame = { mediaType: 'image/jpeg', data: shrunk.toString('base64') }
        else frameError = 'This view was too large to send as a picture; work from the page text.'
      } catch (error) {
        frameError = `The picture of this step could not be prepared: ${describeThrown(error)}`
      }
    }
  }

  // One ledger for the whole desk: the step lands on the run's desk session,
  // interleaved with shell commands and screen events, under the shared seq
  // allocator in lib/desk.ts. `seq` above remains this driver's own step
  // budget; the ledger's sequence is the session's.
  await recordDeskLedgerEvent({
    tenantId: session.tenantId,
    personId: session.personId,
    runId: session.runId,
    kind: STEP_KIND[action] ?? 'read',
    detail: recorded,
    screenshotFileId,
  })
  return {
    seq,
    fileId: screenshotFileId,
    recordingError: recorded.screenshotError ?? null,
    frame: modelFrame,
    frameError,
    frameRepeated,
  }
}

/**
 * What a step hands back for the agent to look at: the picture under the
 * runtime's frame key, or — when there is no picture — the reason, so an
 * agent never assumes it saw something it did not.
 */
function shownFrame(step: StepRecord, url: string): Record<string, AbilityFrame | string | boolean> {
  if (step.frameRepeated) return { frameUnchanged: true }
  if (!step.frame) return step.frameError ? { screenshotError: step.frameError } : {}
  const frame: AbilityFrame = {
    ...step.frame,
    label: `This is your browser's screen right now, on ${url}. Read the picture before you decide what happened — it, not your expectation, is what the page actually did.`,
  }
  return { [ABILITY_FRAME_KEY]: frame }
}

const BUDGET_SPENT = {
  error: `This browser session has used all ${MAX_STEPS} of its steps. Finish with what you have, or close the browser and report what you found.`,
} as const

function budgetSpent(session: LiveSession): boolean {
  return session.seq >= MAX_STEPS
}

/** The summary the agent gets back after any action, plus where it stands. */
async function settledResult(
  session: LiveSession,
  action: string,
  detail: DeskLedgerEventDetail,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const summary = await summarizePage(session.page)
  const step = await recordStep(session, action, { ...detail, url: summary.url, title: summary.title })
  return {
    ...extra,
    ...summary,
    step: step.seq,
    stepsLeft: Math.max(0, MAX_STEPS - session.seq),
    ...shownFrame(step, summary.url),
  }
}

// ---------------------------------------------------------------------------
// The abilities
// ---------------------------------------------------------------------------

/**
 * The agent's browser. Every ability rides the desktop dial — the autonomy
 * dial governs the whole family, and nothing here runs unrecorded.
 */
export function browserAbilities(args: { tenantId: string; person: PersonRow; runId: string }): Ability[] {
  if (!browserSupported()) return []
  const { tenantId, person, runId } = args
  const open = () => getSession({ tenantId, person, runId })

  return [
    defineAbility({
      name: 'browser_open',
      description:
        'Open a page in your own visible browser and look at it. When the person asks you to open, pull up, show, or navigate to a webpage, this is the required result: a fetch or search is not a substitute because it gives them no browser to watch. Also use it for sites that need a sign-in, a search box, a form, or JavaScript. You get the page two ways: as a picture of the screen, which you can actually look at and the person can watch in chat or on a call, and as text — the title, readable content, links, and fields. Work the loop: look at the picture, read what came back, click or type using the EXACT visible text you saw, look again. When the picture and your expectation disagree, the picture is right. If opening fails, say the visible browser failed; do not claim that a later fetch pulled the page up. Public http(s) sites only, one browser per run, 40 steps in total. Every step is also kept on the record, so your operator can replay exactly what you did.',
      category: 'desktop',
      inputSchema: z.object({ url: z.string().describe('Full URL, e.g. https://example.com/pricing') }),
      execute: async ({ url }) => {
        let target: URL
        try {
          target = new URL(url)
        } catch {
          return { error: 'That is not a URL. Give the full address, including https://.' }
        }
        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
          return { error: 'Only http(s) pages can be opened.' }
        }
        const refusal = await assertPublicHost(target).then(
          () => null,
          (error: unknown) => describeThrown(error),
        )
        if (refusal) return { error: refusal }

        const session = await open()
        if (budgetSpent(session)) return BUDGET_SPENT
        session.blocked = null
        let status: number | undefined
        try {
          const response = await session.page.goto(target.toString(), {
            waitUntil: 'domcontentloaded',
            timeout: NAVIGATION_TIMEOUT_MS,
          })
          status = response?.status()
          await settle(session.page)
        } catch (error) {
          const reason = session.blocked ?? describeThrown(error)
          const step = await recordStep(session, 'open', { target: target.toString(), error: reason })
          return {
            error: `The page could not be opened: ${reason}`,
            ...shownFrame(step, session.page.url()),
          }
        }
        return settledResult(session, 'open', { target: target.toString(), ...(status ? { status } : {}) })
      },
    }),
    defineAbility({
      name: 'browser_click',
      description:
        'Click something on the page you have open. Name it by its EXACT visible text — the link or button label exactly as browser_open or browser_read gave it to you — or by a CSS selector when the text is ambiguous. Returns a picture of the page as it stands after the click, plus the page in text and the address you were on before it, so you can see whether the click actually did anything. If nothing matches, you get the list of clickable labels actually on the page; pick one of those. This is also how you work a control that will not take typing — open the calendar, then click the day.',
      category: 'desktop',
      // Continues the visit browser_open was cleared for; it cannot start one.
      approval: 'continues',
      inputSchema: z.object({
        target: z.string().describe('Exact visible link/button text, or a CSS selector'),
      }),
      execute: async ({ target }) => {
        const session = await open()
        if (budgetSpent(session)) return BUDGET_SPENT
        if (session.page.url() === 'about:blank') {
          return { error: 'No page is open yet — use browser_open first.' }
        }
        const match = await markClickable(session.page, target)
        if (!match.found) {
          const step = await recordStep(session, 'click', {
            target,
            error: 'No matching link or button.',
            url: session.page.url(),
          })
          return {
            error: `Nothing on the page matches "${target}".`,
            clickable: match.candidates,
            ...shownFrame(step, session.page.url()),
          }
        }
        const handle = await markedHandle(session.page)
        if (!handle) {
          const step = await recordStep(session, 'click', { target, error: 'The element vanished before the click.' })
          return {
            error: 'That element disappeared before it could be clicked. Read the page again.',
            ...shownFrame(step, session.page.url()),
          }
        }
        // Where the click started from, so a click that did nothing at all is
        // visible in the result rather than only in the picture.
        const cameFrom = session.page.url()
        const wasTitled = await session.page.title().catch(() => '')
        // Somebody is watching: move the pointer onto what is about to be
        // clicked first, so they see the intent and then the action, the way
        // they would watching a colleague. A fifth of a second, and only on a
        // call — see leadCursor.
        await leadCursor(session)
        try {
          await handle.click()
        } catch (error) {
          await handle.dispose()
          const reason = session.blocked ?? describeThrown(error)
          const step = await recordStep(session, 'click', { target: match.label, error: reason })
          return { error: `The click did not land: ${reason}`, ...shownFrame(step, session.page.url()) }
        }
        await handle.dispose()
        await settleAfterInteraction(session.page)
        const landedOn = session.page.url()
        return settledResult(
          session,
          'click',
          { target: match.label },
          {
            clicked: match.label,
            cameFrom,
            movedPage: landedOn !== cameFrom || (await session.page.title().catch(() => '')) !== wasTitled,
          },
        )
      },
    }),
    defineAbility({
      name: 'browser_type',
      description:
        'Type into a field on the page you have open. Name the field by its EXACT visible label, placeholder, or name as browser_open or browser_read listed it (or a CSS selector). Existing content is replaced. Set pressEnter to submit a search box or a login form. The field is read back afterwards and you are told what it actually says: if the text did not go in — a read-only field, or a date picker or dropdown that ignores typing — this fails and says so, and nothing is submitted. Work that control with browser_click instead. Returns a picture of the page and the page in text.',
      category: 'desktop',
      // Continues the visit browser_open was cleared for; it cannot start one.
      approval: 'continues',
      inputSchema: z.object({
        target: z.string().describe('Exact field label, placeholder, name, or a CSS selector'),
        text: z.string().describe('What to type into the field'),
        pressEnter: z.boolean().default(false).describe('Press Enter afterwards to submit'),
      }),
      execute: async ({ target, text, pressEnter }) => {
        const session = await open()
        if (budgetSpent(session)) return BUDGET_SPENT
        if (session.page.url() === 'about:blank') {
          return { error: 'No page is open yet — use browser_open first.' }
        }
        const match = await markField(session.page, target)
        if (!match.found) {
          const step = await recordStep(session, 'type', {
            target,
            error: 'No matching field.',
            url: session.page.url(),
          })
          return {
            error: `No field on the page matches "${target}".`,
            fields: match.candidates,
            ...shownFrame(step, session.page.url()),
          }
        }
        // The typed value is evidence, but a password never belongs in a
        // ledger — nor in anything handed back to the model.
        const secret = match.type === 'password'
        const recordedText = secret ? '[password withheld]' : text
        const reveal = (value: string) => (secret ? '[password withheld]' : value)
        const before = await readMarkedField(session.page)
        const handle = await markedHandle(session.page)
        if (!handle) {
          const step = await recordStep(session, 'type', {
            target: match.label,
            error: 'The field vanished before typing.',
          })
          return {
            error: 'That field disappeared before it could be used. Read the page again.',
            ...shownFrame(step, session.page.url()),
          }
        }
        await leadCursor(session)
        try {
          // Triple-click selects whatever is already there, so typing replaces it.
          await handle.click({ count: 3 })
          await handle.type(text, { delay: 20 })
        } catch (error) {
          await handle.dispose()
          const reason = describeThrown(error)
          const step = await recordStep(session, 'type', {
            target: match.label,
            text: recordedText,
            error: reason,
          })
          return { error: `The text could not be entered: ${reason}`, ...shownFrame(step, session.page.url()) }
        }
        await handle.dispose()
        await settle(session.page)

        // The honest part: what does the field actually say now? Keystrokes
        // Chromium delivered happily are keystrokes a widget may have thrown
        // away, and an agent told "typed successfully" by a field that never
        // changed will go on to report on a search it never ran.
        const after = await readFieldAgain(session.page, target)
        const wanted = text.replace(/\s+/g, ' ').trim()
        const now = after?.value ?? ''
        // A field that took the text may still not echo it back verbatim —
        // dates get reformatted, phone numbers get masked — so anything that
        // overlaps what was sent, or simply changed, counts as taken. What
        // does not count is a field sitting there saying exactly what it said
        // before, which is precisely the datepicker case.
        const took =
          after !== null &&
          (wanted.length === 0
            ? now.length === 0
            : now.length > 0 &&
              (now === wanted ||
                now.toLowerCase().includes(wanted.toLowerCase()) ||
                wanted.toLowerCase().includes(now.toLowerCase()) ||
                now !== (before?.value ?? '')))
        if (after !== null && !took) {
          const cause = after.disabled
            ? 'The field is disabled — it will not take anything you type.'
            : after.readOnly
              ? 'The field is read-only: it is filled by a control, not by typing.'
              : 'The field threw the keystrokes away — this is what a date picker, a calendar, or a custom dropdown does to typed text.'
          return settledResult(
            session,
            'type',
            {
              target: match.label,
              text: recordedText,
              error: `The field still reads "${reveal(now) || '(empty)'}" — the typing did not take.`,
            },
            {
              error: `Typing into "${match.label}" did not take. The field still reads "${reveal(now) || '(empty)'}", not what you sent.`,
              fieldNowReads: reveal(now),
              likelyCause: cause,
              note: 'Do not send this again — it will fail the same way. Look at the picture of the page, open the control with browser_click (the field itself, or the calendar or dropdown icon beside it), and click the value you want.',
              submitted: false,
            },
          )
        }

        if (pressEnter) {
          await session.page.keyboard.press('Enter')
          await settleAfterInteraction(session.page)
        }
        return settledResult(
          session,
          'type',
          { target: match.label, text: recordedText },
          {
            typedInto: match.label,
            submitted: pressEnter,
            // Verified where the page let us look, and honest where it did not.
            ...(after === null
              ? {
                  verified: false,
                  note: 'The field was no longer on the page to check afterwards, so what it holds is unconfirmed — check the picture before you rely on it.',
                }
              : { fieldNowReads: reveal(now) }),
          },
        )
      },
    }),
    defineAbility({
      name: 'browser_read',
      description:
        'Look at the page your browser is on right now, without touching it — a fresh picture of the screen, plus the title, the readable text, the clickable links, the fields. Use it after a click or after typing when you want to see where you stand before deciding.',
      category: 'desktop',
      // Continues the visit browser_open was cleared for; it cannot start one.
      approval: 'continues',
      inputSchema: z.object({}),
      execute: async () => {
        const session = await open()
        if (budgetSpent(session)) return BUDGET_SPENT
        if (session.page.url() === 'about:blank') {
          return { error: 'No page is open yet — use browser_open first.' }
        }
        return settledResult(session, 'read', {})
      },
    }),
    defineAbility({
      name: 'browser_screenshot',
      description:
        'Keep the current view as a picture on the run record — take one when the screen itself is the evidence: a confirmation number, a receipt, a chart. You get the picture back to look at as well, along with the file id you can cite or attach. For simply seeing where you are, browser_read is cheaper and gives you the page text with it.',
      category: 'desktop',
      // Continues the visit browser_open was cleared for; it cannot start one.
      approval: 'continues',
      inputSchema: z.object({}),
      execute: async () => {
        const session = await open()
        if (budgetSpent(session)) return BUDGET_SPENT
        if (session.page.url() === 'about:blank') {
          return { error: 'No page is open yet — use browser_open first.' }
        }
        const url = session.page.url()
        const step = await recordStep(session, 'screenshot', {
          url,
          title: await session.page.title().catch(() => ''),
        })
        return step.fileId
          ? {
              fileId: step.fileId,
              step: step.seq,
              stepsLeft: Math.max(0, MAX_STEPS - session.seq),
              ...shownFrame(step, url),
            }
          : { error: step.recordingError ?? 'The screen could not be captured.' }
      },
    }),
    defineAbility({
      name: 'browser_close',
      description:
        'Close the browser when you are finished with it entirely — not between pages. On a call the person you are talking to is WATCHING this browser, so closing it takes the picture off their screen; leave it open while you are still working and it will be closed for you when the call ends. Everything you did stays on the record either way.',
      category: 'desktop',
      // Continues the visit browser_open was cleared for; it cannot start one.
      approval: 'continues',
      inputSchema: z.object({}),
      execute: async () => {
        const map = liveSessions()
        if (!map.has(runId)) return { closed: false, note: 'No browser is open.' }
        const session = await open()
        // The last frame still goes on the record; nobody needs to look at the
        // page they are walking away from.
        const step = await recordStep(
          session,
          'close',
          { url: session.page.url(), title: await session.page.title().catch(() => '') },
          { show: false },
        )
        await closeBrowserSession(runId)
        return { closed: true, steps: step.seq }
      },
    }),
  ]
}
