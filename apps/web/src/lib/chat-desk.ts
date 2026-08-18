import 'server-only'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { ActionCategory, AutonomyLevel } from '@bunkhouse/runtime'
import { deskEvents, deskSessions, people, runs, type DeskLedgerEventDetail, type DeskLedgerEventKind } from '../db/schema'
import { db } from '../db/client'
import {
  AGENT_SCREEN_DRIVING_FPS,
  AGENT_SCREEN_HEIGHT,
  AGENT_SCREEN_WATCHING_FPS,
  AGENT_SCREEN_WIDTH,
} from './agent-screen'
import { getDeskPolicy, resolveDeskFeatures, type DeskFeatures, type DeskPolicy } from './desk-policy'
import {
  beginDeskHandover,
  captureDeskFrame,
  configuredDeskRunner,
  dbDeskLedgerStore,
  deskIdFor,
  endDeskHandover,
  leaseDesk,
  openDeskFrameStream,
  openDeskVideoStream,
  recordDeskLedgerEvent,
  sendDeskInput,
  startDeskScreen,
  stopDeskScreen,
  tuneDeskFrames,
  tuneDeskVideo,
  type DeskClientDeps,
  type DeskInputAction,
  type DeskLedgerStore,
} from './desk'

/**
 * The desk, driven by a PERSON.
 *
 * The chat page shows an agent's desktop beside the conversation, and lets the
 * operator take the keyboard. That is the same expensive, gated tier the agent
 * reaches through `open_desktop` and `desktop_*` — so it passes the same gates,
 * in the same order, and lands on the same append-only ledger. A human at the
 * controls is not an exemption from governance; it is another actor on the
 * record.
 *
 * Every entry point here enforces, and fails closed on, all of:
 *
 *   1. a configured desk runner — with none there is no machine at all (§3.23),
 *      and there is deliberately no degraded local fallback;
 *   2. the agent is a live agent in THIS tenant (every query is tenant-scoped,
 *      RLS-enforced, never query discipline alone);
 *   3. the `desk` feature gate — the parent;
 *   4. the `desktop` feature gate — the child, which `resolveDeskFeatures`
 *      already forces off whenever the parent is off;
 *   5. the agent's own autonomy dial for the `desktop` category.
 *
 * On (5), precisely: `forbidden` refuses. `approval`, `notify` and `trusted`
 * proceed — because the human operating the controls, holding `work.manage`,
 * in session, IS the decision that `approval` exists to collect, and the whole
 * interaction is recorded. Refusing `approval` here would leave the desktop
 * dead by default (`approval` is the default level) while telling operators
 * their dial means something it does not.
 *
 * The ledger these write into is the RUN's. Desk sessions are per-run by
 * design (§3.19) — one session, one interleaved stream of everything that
 * happened at that desk — so an operator's clicks land in the same chapter as
 * the agent's, in order, rather than in a private log of their own.
 */

export type ChatDeskDeps = DeskClientDeps & {
  store?: DeskLedgerStore
  /** Whether this person is a live agent of this tenant. */
  isAgent?: (args: { tenantId: string; personId: string }) => Promise<boolean>
  policy?: (tenantId: string) => Promise<DeskPolicy>
  features?: (tenantId: string) => Promise<DeskFeatures>
  dial?: (args: { tenantId: string; personId: string }) => Promise<(category: ActionCategory) => AutonomyLevel>
  /** The run this desk work belongs to; defaults to the agent's current one. */
  resolveRunId?: (args: { tenantId: string; personId: string }) => Promise<string | null>
  /** Whether a screen is open right now, from the ledger. */
  screenRunning?: (args: { tenantId: string; personId: string }) => Promise<boolean>
  /** When the live handover began, for the recorded duration. */
  handoverStartedAt?: (args: { tenantId: string; runId: string }) => Promise<Date | null>
}

export type DeskRefusal = { error: string }
export type DeskOk = { ok: true }

export type ChatDeskStatus = {
  supported: boolean
  desk: boolean
  desktop: boolean
  screenRunning: boolean
  reason?: string
}

/** Who is at the controls — recorded on every operator-driven event. */
export type DeskActor = { name: string }

/**
 * The agent's own dial, resolved. Imported on use rather than at module scope:
 * the run engine is a large graph to pull in behind a page that is only asking
 * whether a button should be enabled.
 */
function loadAutonomyDial(): NonNullable<ChatDeskDeps['dial']> {
  return async (args) => {
    const { autonomyDial } = await import('./agent-runs')
    const app = db()
    return app.withTenantContext(args.tenantId, () => autonomyDial(args))
  }
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() || 'no reason given'
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

type Admitted = {
  deskId: string
  runId: string
  features: DeskFeatures
  policy: DeskPolicy
  store: DeskLedgerStore
  clientDeps: DeskClientDeps
}

function clientDepsOf(deps: ChatDeskDeps): DeskClientDeps {
  return {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.runner ? { runner: deps.runner } : {}),
  }
}

async function isLiveAgent(tenantId: string, personId: string): Promise<boolean> {
  const app = db()
  const [row] = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.id, personId), eq(people.kind, 'agent'), eq(people.status, 'active')))
      .limit(1),
  )
  return Boolean(row)
}

/**
 * The run an operator's desk work belongs to: the agent's live desk session if
 * it has one, otherwise its most recent run. A desk session cannot exist
 * without a run — the ledger is run-anchored — so with no run at all there is
 * nowhere for this to be recorded, and it is refused rather than done off the
 * record.
 */
async function currentRunId(tenantId: string, personId: string): Promise<string | null> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [live] = await app.db
      .select({ runId: deskSessions.runId })
      .from(deskSessions)
      .where(and(eq(deskSessions.personId, personId), eq(deskSessions.status, 'active')))
      .orderBy(desc(deskSessions.startedAt))
      .limit(1)
    if (live) return live.runId
    const [latest] = await app.db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.personId, personId))
      .orderBy(desc(runs.startedAt))
      .limit(1)
    return latest?.id ?? null
  })
}

/** Is a screen open on this agent's desk? Read from the ledger, which is the
 *  record of it — the runner has no "is a screen up" question to ask. */
async function screenRunningFromLedger(tenantId: string, personId: string): Promise<boolean> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [session] = await app.db
      .select({ id: deskSessions.id })
      .from(deskSessions)
      .where(and(eq(deskSessions.personId, personId), eq(deskSessions.status, 'active')))
      .orderBy(desc(deskSessions.startedAt))
      .limit(1)
    if (!session) return false
    const [last] = await app.db
      .select({ kind: deskEvents.kind })
      .from(deskEvents)
      .where(and(eq(deskEvents.sessionId, session.id), inArray(deskEvents.kind, ['screen_open', 'screen_close'])))
      .orderBy(desc(deskEvents.seq))
      .limit(1)
    return last?.kind === 'screen_open'
  })
}

async function handoverStartedAtFromLedger(tenantId: string, runId: string): Promise<Date | null> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [session] = await app.db
      .select({ id: deskSessions.id })
      .from(deskSessions)
      .where(eq(deskSessions.runId, runId))
      .limit(1)
    if (!session) return null
    const [last] = await app.db
      .select({ kind: deskEvents.kind, at: deskEvents.at })
      .from(deskEvents)
      .where(and(eq(deskEvents.sessionId, session.id), inArray(deskEvents.kind, ['handover_begin', 'handover_end'])))
      .orderBy(desc(deskEvents.seq))
      .limit(1)
    return last?.kind === 'handover_begin' ? last.at : null
  })
}

/**
 * Every gate, in order, once. Returns a refusal in the operator's language —
 * never a stack trace, never a half-open door.
 */
async function admit(
  args: { tenantId: string; personId: string; needsDesktop: boolean },
  deps: ChatDeskDeps,
): Promise<Admitted | DeskRefusal> {
  const clientDeps = clientDepsOf(deps)
  if ((clientDeps.runner ?? configuredDeskRunner()) === null) {
    return { error: 'Agent machines are not available on this installation.' }
  }
  const liveAgent = deps.isAgent ?? (({ tenantId, personId }) => isLiveAgent(tenantId, personId))
  if (!(await liveAgent({ tenantId: args.tenantId, personId: args.personId }))) {
    return { error: 'That agent is not part of this company, or is no longer active.' }
  }
  const features = await (deps.features ?? resolveDeskFeatures)(args.tenantId)
  if (!features.desk) {
    return { error: 'Agent machines are turned off for this company. An administrator can enable them in Settings → Features.' }
  }
  if (args.needsDesktop && !features.desktop) {
    return { error: 'The desktop screen is turned off for this company. An administrator can enable it in Settings → Features.' }
  }
  if (args.needsDesktop) {
    const dial = await (deps.dial ?? loadAutonomyDial())({ tenantId: args.tenantId, personId: args.personId })
    if (dial('desktop') === 'forbidden') {
      return { error: 'This agent’s desktop autonomy is set to forbidden — nobody may drive its screen until that dial is changed on its profile.' }
    }
  }
  const runId = await (deps.resolveRunId ?? (() => currentRunId(args.tenantId, args.personId)))({
    tenantId: args.tenantId,
    personId: args.personId,
  })
  if (!runId) {
    return { error: 'This agent has not worked yet, so there is no session to record a desktop against. Send it a message first.' }
  }
  return {
    deskId: deskIdFor(args.tenantId, args.personId),
    runId,
    features,
    policy: await (deps.policy ?? getDeskPolicy)(args.tenantId),
    store: deps.store ?? dbDeskLedgerStore(),
    clientDeps,
  }
}

function refused(value: Admitted | DeskRefusal): value is DeskRefusal {
  return 'error' in value
}

/** Append to the run's desk ledger, through the same serialized allocator the
 *  agent's own steps use, so one session keeps one ordered stream. */
async function record(
  args: { tenantId: string; personId: string; runId: string; kind: DeskLedgerEventKind; detail: DeskLedgerEventDetail },
  admitted: Admitted,
): Promise<{ sessionId: string; seq: number }> {
  return recordDeskLedgerEvent({
    tenantId: args.tenantId,
    personId: args.personId,
    runId: args.runId,
    kind: args.kind,
    detail: args.detail,
    store: admitted.store,
  })
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * What the chat page may offer for this agent, and why not when it may not.
 * `reason` is the operator-facing explanation when the desktop is unavailable,
 * and — when a screen IS open — the justification recorded for opening it.
 */
export async function deskStatus(
  args: { tenantId: string; personId: string },
  deps: ChatDeskDeps = {},
): Promise<ChatDeskStatus> {
  const supported = (clientDepsOf(deps).runner ?? configuredDeskRunner()) !== null
  const features = supported
    ? await (deps.features ?? resolveDeskFeatures)(args.tenantId)
    : { desk: false, desktop: false }
  let desktop = features.desktop
  let reason: string | undefined
  if (!supported) reason = 'Agent machines are not available on this installation.'
  else if (!features.desk) reason = 'Agent machines are turned off for this company.'
  else if (!features.desktop) reason = 'The desktop screen is turned off for this company.'
  else {
    const dial = await (deps.dial ?? loadAutonomyDial())({ tenantId: args.tenantId, personId: args.personId })
    if (dial('desktop') === 'forbidden') {
      desktop = false
      reason = 'This agent’s desktop autonomy is set to forbidden.'
    }
  }
  const screenRunning =
    supported && desktop
      ? await (deps.screenRunning ?? (() => screenRunningFromLedger(args.tenantId, args.personId)))({
          tenantId: args.tenantId,
          personId: args.personId,
        })
      : false
  return {
    supported,
    desk: supported && features.desk,
    desktop,
    screenRunning,
    ...(reason ? { reason } : {}),
  }
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

/**
 * Open the agent's desktop screen for an operator to watch and drive.
 *
 * Recorded exactly the way `open_desktop` records the agent's own (§3.17):
 * into `desk_sessions.screen_reason` and onto the ledger as a `screen_open`
 * event carrying the actor. What is NOT asked for here is prose from the
 * person: §3.17's stated reason exists so a reviewer can catch the AGENT
 * reaching for the expensive tier when a connector would have done, and an
 * operator opening their own agent's screen from their own console is not
 * escalating anything and has nobody to justify it to. So the record says the
 * true thing — that a named person opened it by hand — instead of demanding a
 * sentence with no reader. The agent's own ability still states its case, and
 * still refuses without one (lib/desk.ts).
 *
 * A caller with a real reason (a handover, say) passes it and it is recorded
 * verbatim.
 */
export async function openDesktop(
  args: { tenantId: string; personId: string; actor: DeskActor; reason?: string },
  deps: ChatDeskDeps = {},
): Promise<DeskOk | DeskRefusal> {
  const reason = args.reason?.trim() || `Opened from the chat console by ${args.actor.name}`
  const admitted = await admit({ ...args, needsDesktop: true }, deps)
  if (refused(admitted)) return admitted
  try {
    await leaseDesk(
      {
        deskId: admitted.deskId,
        memoryMb: admitted.policy.memoryMb,
        vcpus: admitted.policy.vcpus,
        leaseMs: admitted.policy.leaseMs,
      },
      admitted.clientDeps,
    )
    await startDeskScreen(
      { deskId: admitted.deskId, width: AGENT_SCREEN_WIDTH, height: AGENT_SCREEN_HEIGHT },
      admitted.clientDeps,
    )
  } catch (error) {
    return { error: `The screen could not be started: ${describeError(error)}` }
  }
  const { sessionId } = await record(
    {
      tenantId: args.tenantId,
      personId: args.personId,
      runId: admitted.runId,
      kind: 'screen_open',
      detail: {
        width: AGENT_SCREEN_WIDTH,
        height: AGENT_SCREEN_HEIGHT,
        reason,
        actor: args.actor.name,
      },
    },
    admitted,
  )
  await admitted.store.markScreenOpened({ tenantId: args.tenantId, sessionId, reason })
  return { ok: true }
}

export async function closeDesktop(
  args: { tenantId: string; personId: string; actor: DeskActor },
  deps: ChatDeskDeps = {},
): Promise<DeskOk | DeskRefusal> {
  const admitted = await admit({ ...args, needsDesktop: true }, deps)
  if (refused(admitted)) return admitted
  try {
    await stopDeskScreen(admitted.deskId, admitted.clientDeps)
  } catch (error) {
    return { error: `The screen could not be stopped: ${describeError(error)}` }
  }
  await record(
    {
      tenantId: args.tenantId,
      personId: args.personId,
      runId: admitted.runId,
      kind: 'screen_close',
      detail: { actor: args.actor.name },
    },
    admitted,
  )
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const INPUT_KIND: Record<DeskInputAction['action'], DeskLedgerEventKind> = {
  move: 'move',
  click: 'click',
  type: 'type',
  key: 'key',
  scroll: 'scroll',
  drag: 'drag',
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/**
 * Validate the desk-v1 input shape at the boundary. Anything the runner would
 * coerce into a NaN click is refused here instead, with a sentence rather than
 * a 400 from a service the operator has never heard of.
 */
export function parseDeskInput(value: unknown): DeskInputAction | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const point = (source: unknown): { x: number; y: number } | null => {
    if (!source || typeof source !== 'object') return null
    const x = integer((source as Record<string, unknown>).x)
    const y = integer((source as Record<string, unknown>).y)
    return x === null || y === null ? null : { x, y }
  }
  const x = integer(raw.x)
  const y = integer(raw.y)
  switch (raw.action) {
    case 'move':
      return x === null || y === null ? null : { action: 'move', x, y }
    case 'click': {
      if (x === null || y === null) return null
      const button = raw.button === 'middle' || raw.button === 'right' ? raw.button : 'left'
      const clicks = raw.clicks === 2 ? 2 : 1
      return { action: 'click', x, y, button, clicks }
    }
    case 'type':
      return typeof raw.text === 'string' ? { action: 'type', text: raw.text } : null
    case 'key':
      return typeof raw.combo === 'string' && raw.combo.trim() ? { action: 'key', combo: raw.combo } : null
    case 'scroll': {
      if (x === null || y === null) return null
      const dx = typeof raw.dx === 'number' && Number.isInteger(raw.dx) ? raw.dx : 0
      const dy = typeof raw.dy === 'number' && Number.isInteger(raw.dy) ? raw.dy : 0
      return { action: 'scroll', x, y, dx, dy }
    }
    case 'drag': {
      const from = point(raw.from)
      const to = point(raw.to)
      return from && to ? { action: 'drag', from, to } : null
    }
    default:
      return null
  }
}

/**
 * One operator input on the agent's screen.
 *
 * Recorded like the agent's own equivalent step — including typed text —
 * because this is a person using the product's own controls, on the record,
 * knowingly. That is exactly the line §3.14 draws: what goes through THIS door
 * is evidence, and what goes through a HANDOVER is masked, because a handover
 * exists for the step nobody should be recording (a one-time code, a password
 * on someone's phone). Do not blur the two by masking here or by recording
 * there.
 */
export async function sendDesktopInput(
  args: { tenantId: string; personId: string; actor: DeskActor; action: DeskInputAction },
  deps: ChatDeskDeps = {},
): Promise<DeskOk | DeskRefusal> {
  const admitted = await admit({ ...args, needsDesktop: true }, deps)
  if (refused(admitted)) return admitted
  try {
    await sendDeskInput({ deskId: admitted.deskId, action: args.action }, admitted.clientDeps)
  } catch (error) {
    return { error: `That did not land on the screen: ${describeError(error)}` }
  }
  const { action, ...rest } = args.action
  await record(
    {
      tenantId: args.tenantId,
      personId: args.personId,
      runId: admitted.runId,
      kind: INPUT_KIND[action],
      detail: { ...(rest as DeskLedgerEventDetail), actor: args.actor.name },
    },
    admitted,
  )
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Handover
// ---------------------------------------------------------------------------

/** How long an operator's takeover lasts before the runner revokes it. */
const TAKEOVER_TTL_MINUTES = 15

/**
 * Begin or end a handover — the masked mode (§3.14).
 *
 * While a person has the screen this way, NOTHING they do is recorded and
 * nothing they see reaches the agent's context: `@braedonsaunders/appkit-desk` withholds
 * frames for the duration, so even the live view goes quiet at the source.
 * What is recorded is the boundary and only the boundary — who took it, at
 * what scope, and for how long. That masking is load-bearing: it is what makes
 * it safe for a person to type a one-time code or a password on an agent's
 * machine, and it must never be "improved" into a keystroke log.
 */
export async function setTakeover(
  args: { tenantId: string; personId: string; actor: DeskActor; enabled: boolean },
  deps: ChatDeskDeps = {},
): Promise<{ ok: true; active: boolean; url?: string } | DeskRefusal> {
  const admitted = await admit({ ...args, needsDesktop: true }, deps)
  if (refused(admitted)) return admitted

  if (args.enabled) {
    // A handover needs a screen. Starting one here mirrors `request_takeover`,
    // which does the same for an agent that has been working headless — and
    // the reason recorded is the honest one: a person asked for the controls.
    const running = await (deps.screenRunning ?? (() => screenRunningFromLedger(args.tenantId, args.personId)))({
      tenantId: args.tenantId,
      personId: args.personId,
    })
    if (!running) {
      const opened = await openDesktop(
        { ...args, reason: `Handover to ${args.actor.name}.` },
        deps,
      )
      if ('error' in opened) return opened
    }
    let handover: { url: string }
    try {
      handover = await beginDeskHandover(
        {
          deskId: admitted.deskId,
          ttlMs: TAKEOVER_TTL_MINUTES * 60_000,
          scope: 'control',
          actor: args.actor.name,
        },
        admitted.clientDeps,
      )
    } catch (error) {
      return { error: `The handover could not be opened: ${describeError(error)}` }
    }
    await record(
      {
        tenantId: args.tenantId,
        personId: args.personId,
        runId: admitted.runId,
        kind: 'handover_begin',
        // The boundary, and only the boundary.
        detail: { actor: args.actor.name, scope: 'control' },
      },
      admitted,
    )
    // The capability URL the runner minted for this handover, TTL-bounded and
    // revoked the moment it ends. Handed back so the operator can actually
    // reach the screen — the same URL `request_takeover` gives an agent to
    // pass to a person. It is not part of the minimum contract; a caller that
    // only needs the toggle can ignore it.
    return { ok: true, active: true, url: handover.url }
  }

  // The duration comes from the ledger's own `handover_begin`, read BEFORE the
  // end is written, and not from a timer held in this process: the end may
  // well be served by a different one.
  const startedAt = await (deps.handoverStartedAt ?? (() => handoverStartedAtFromLedger(args.tenantId, admitted.runId)))({
    tenantId: args.tenantId,
    runId: admitted.runId,
  })
  try {
    await endDeskHandover(admitted.deskId, admitted.clientDeps)
  } catch (error) {
    return { error: `The handover could not be ended: ${describeError(error)}` }
  }
  await record(
    {
      tenantId: args.tenantId,
      personId: args.personId,
      runId: admitted.runId,
      kind: 'handover_end',
      detail: {
        actor: args.actor.name,
        scope: 'control',
        ...(startedAt ? { durationMs: Math.max(0, Date.now() - startedAt.getTime()) } : {}),
      },
    },
    admitted,
  )
  return { ok: true, active: false }
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * The live view, gated exactly like everything else here and then proxied.
 * The caller gets a stream of `data: {"png","width","height","seq"}` records —
 * the runner's address and bearer token never leave the server.
 */
export async function deskFrames(
  args: { tenantId: string; personId: string; signal?: AbortSignal },
  deps: ChatDeskDeps = {},
): Promise<{ stream: ReadableStream<Uint8Array> } | DeskRefusal> {
  const admitted = await admit({ ...args, needsDesktop: true }, deps)
  if (refused(admitted)) return admitted
  try {
    const intended = await (deps.screenRunning ?? (() => screenRunningFromLedger(args.tenantId, args.personId)))({
      tenantId: args.tenantId,
      personId: args.personId,
    })
    if (!intended) return { error: 'The desktop screen is not open.' }
    await leaseDesk(
      {
        deskId: admitted.deskId,
        memoryMb: admitted.policy.memoryMb,
        vcpus: admitted.policy.vcpus,
        leaseMs: admitted.policy.leaseMs,
      },
      admitted.clientDeps,
    )
    // The ledger is the durable intent; the runner's screen handle is
    // deliberately ephemeral. A runner restart or VM resume can therefore
    // leave an open screen recorded with no in-memory handle to stream. Start
    // is idempotent and reconciles those two states before subscribing.
    await startDeskScreen(
      { deskId: admitted.deskId, width: AGENT_SCREEN_WIDTH, height: AGENT_SCREEN_HEIGHT },
      admitted.clientDeps,
    )
    const stream = await openDeskFrameStream(
      {
        deskId: admitted.deskId,
        // A subscription starts at the watching rate. It is raised the moment
        // somebody takes the controls (`setDeskFrameRate`) and lowered again
        // when they let go, without this stream being touched.
        fps: AGENT_SCREEN_WATCHING_FPS,
        width: AGENT_SCREEN_WIDTH,
        height: AGENT_SCREEN_HEIGHT,
        ...(args.signal ? { signal: args.signal } : {}),
      },
      admitted.clientDeps,
    )
    return { stream }
  } catch (error) {
    return { error: `The live view could not be opened: ${describeError(error)}` }
  }
}

/**
 * The live view as video, gated exactly like everything else here and proxied.
 *
 * The caller gets the runner's binary chunk stream untouched — the runner's
 * address and bearer token never leave the server, and nothing in between
 * decodes a byte of it. This is what the pane actually watches; `deskFrames`
 * below is the fallback for a browser that cannot play it.
 */
export async function deskVideo(
  args: { tenantId: string; personId: string; signal?: AbortSignal },
  deps: ChatDeskDeps = {},
): Promise<{ stream: ReadableStream<Uint8Array> } | DeskRefusal> {
  const admitted = await admit({ ...args, needsDesktop: true }, deps)
  if (refused(admitted)) return admitted
  try {
    const intended = await (deps.screenRunning ?? (() => screenRunningFromLedger(args.tenantId, args.personId)))({
      tenantId: args.tenantId,
      personId: args.personId,
    })
    if (!intended) return { error: 'The desktop screen is not open.' }
    await leaseDesk(
      {
        deskId: admitted.deskId,
        memoryMb: admitted.policy.memoryMb,
        vcpus: admitted.policy.vcpus,
        leaseMs: admitted.policy.leaseMs,
      },
      admitted.clientDeps,
    )
    await startDeskScreen(
      { deskId: admitted.deskId, width: AGENT_SCREEN_WIDTH, height: AGENT_SCREEN_HEIGHT },
      admitted.clientDeps,
    )
    const stream = await openDeskVideoStream(
      {
        deskId: admitted.deskId,
        // A subscription starts at the watching rate and is raised the moment
        // somebody takes the controls (`setDeskFrameRate`), without this
        // stream being touched.
        fps: AGENT_SCREEN_WATCHING_FPS,
        width: AGENT_SCREEN_WIDTH,
        height: AGENT_SCREEN_HEIGHT,
        ...(args.signal ? { signal: args.signal } : {}),
      },
      admitted.clientDeps,
    )
    return { stream }
  } catch (error) {
    return { error: `The live view could not be opened: ${describeError(error)}` }
  }
}

/**
 * How fast the live view should be captured, given what the operator is doing.
 *
 * DRIVING is a control loop with a person in it. The guest's own cursor is not
 * in the picture, so the only pointer the operator can see is their own, and a
 * desktop that repaints five times a second under it feels broken however
 * correct the clicks are. WATCHING is a glance, and a glance does not need to
 * be paid for at thirty frames a second on a nested VM.
 *
 * Same gates as everything else here, and no ledger entry: a rate is not an
 * act on the agent's machine, it is how often we ask to see it. Taking the
 * controls IS recorded — every input this pane forwards lands on the run
 * record — and that is the event worth having.
 *
 * The rate belongs to the desk's one capture, not to a viewer, so this is
 * honest about what it changes: with two people watching, the faster of them
 * sets the pace for both.
 */
export async function setDeskFrameRate(
  args: { tenantId: string; personId: string; driving: boolean },
  deps: ChatDeskDeps = {},
): Promise<{ ok: true; fps: number; streaming: boolean } | DeskRefusal> {
  const admitted = await admit({ ...args, needsDesktop: true }, deps)
  if (refused(admitted)) return admitted
  const fps = args.driving ? AGENT_SCREEN_DRIVING_FPS : AGENT_SCREEN_WATCHING_FPS
  const geometry = { deskId: admitted.deskId, fps, width: AGENT_SCREEN_WIDTH, height: AGENT_SCREEN_HEIGHT }
  try {
    // Both live-view pumps are re-tuned, because which one the pane is on
    // depends on the browser: a viewer watching video and a viewer on the
    // still-picture fallback must both speed up when the controls are taken.
    // Neither call starts anything — with nothing running the runner answers
    // `streaming: false` and changes nothing — so tuning the one that is idle
    // costs a round trip and nothing else.
    const [tuned] = await Promise.all([
      tuneDeskVideo(geometry, admitted.clientDeps),
      tuneDeskFrames(geometry, admitted.clientDeps).catch(() => undefined),
    ])
    // `streaming: false` means there was no capture to re-tune — the caller
    // asked before its own subscription reached the runner. Reported rather
    // than smoothed over, so the caller can ask again instead of driving at
    // the watching rate and blaming the machine.
    return { ok: true, fps: tuned.fps, streaming: tuned.streaming }
  } catch (error) {
    return { error: `The live view's rate could not be changed: ${describeError(error)}` }
  }
}

/**
 * One still of the same screen, for the polling fallback — same gates, same
 * refusals, one observation instead of a subscription.
 */
export async function deskFrame(
  args: { tenantId: string; personId: string },
  deps: ChatDeskDeps = {},
): Promise<{ png: string; width: number; height: number } | DeskRefusal> {
  const admitted = await admit({ ...args, needsDesktop: true }, deps)
  if (refused(admitted)) return admitted
  try {
    return await captureDeskFrame(admitted.deskId, admitted.clientDeps)
  } catch (error) {
    return { error: `The screen could not be observed: ${describeError(error)}` }
  }
}
