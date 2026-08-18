import 'server-only'
import sharp from 'sharp'
import type { CDPSession, Page } from 'puppeteer-core'
import { AGENT_SCREEN_FPS, AGENT_SCREEN_HEIGHT, AGENT_SCREEN_WIDTH } from './agent-screen'

/**
 * Casting the agent's browser — the half of the live view that lives inside
 * the browser session, and knows nothing about LiveKit.
 *
 * Two jobs:
 *
 *   1. **A cursor to watch.** Puppeteer drives a page through the devtools
 *      protocol, and a devtools mouse leaves no pointer on the screen: the
 *      page receives perfectly real mouse events and paints nothing. So the
 *      pointer is drawn into the page — a closed shadow root hung off
 *      `<html>`, following the real mouse events and flashing on a real press,
 *      so what the viewer sees is what actually happened rather than an
 *      animation we narrated over it.
 *
 *   2. **A stream of frames.** Chromium's own `Page.startScreencast` emits a
 *      JPEG whenever the page repaints, with an ack per frame. That is the
 *      frame source. Screenshotting in a loop is the thing this replaces: it
 *      costs a full capture round trip per frame whether or not anything moved,
 *      and it competes with the agent's actual work for the same page.
 *
 * Who receives the frames is injected. Calls register their own room; other
 * governed runs register a run-scoped room for the chat work surface. The
 * opener itself is lazy, so a run that never uses a browser creates no room,
 * cursor, screencast, encoder, or added latency.
 */

/** One converted frame, in the packed RGBA a video source wants. */
export type AgentScreenFrame = {
  /** `width * height * 4` bytes, row-major, no padding. */
  data: Uint8Array
  width: number
  height: number
}

/** Where converted frames go. Implemented by the voice agent, over LiveKit. */
export type AgentScreenPublisher = {
  /**
   * Take one frame. Must not block and must not throw: this is called from the
   * screencast handler, on the same event loop as the agent's own work.
   */
  publish: (frame: AgentScreenFrame) => void
  /** Stop sending, unpublish, and release everything. Idempotent. */
  close: () => Promise<void>
}

/**
 * Opens a publisher for one browser session, at the size frames will arrive
 * at. Called at most once per session, when the browser actually opens — a
 * call where the agent never touches a browser publishes nothing.
 */
export type AgentScreenOpener = (size: { width: number; height: number }) => Promise<AgentScreenPublisher>

/** A running cast: the CDP screencast, its publisher, and the way to end both. */
export type BrowserCast = {
  /** Stop the screencast, detach CDP, and close the publisher. Idempotent. */
  stop: () => Promise<void>
}

// --- The registry: who, if anyone, is watching this run --------------------

type CastRegistry = typeof globalThis & {
  __bunkhouseBrowserCastOpeners?: Map<string, Set<RegisteredScreenOpener>>
  __bunkhouseBrowserCastsLive?: Map<string, Set<BrowserCast>>
}
const castRegistry = globalThis as CastRegistry

type RegisteredScreenOpener = {
  opener: AgentScreenOpener
  active: boolean
  publishers: Set<AgentScreenPublisher>
}

// On globalThis for the same reason the live browser sessions are: Next
// rebuilds module graphs in dev, and a reload must never orphan a published
// track or a running screencast.
function openers(): Map<string, Set<RegisteredScreenOpener>> {
  return (castRegistry.__bunkhouseBrowserCastOpeners ??= new Map())
}

/** One frame source can have a chat observer and a call observer at once. */
function fanoutOpener(runId: string): AgentScreenOpener | null {
  const registered = openers().get(runId)
  if (!registered?.size) return null
  return async (size) => {
    let closed = false
    const publishers = new Map<RegisteredScreenOpener, AgentScreenPublisher>()
    const pending = new Set<RegisteredScreenOpener>()
    const failedAt = new Map<RegisteredScreenOpener, number>()

    const attach = async (registration: RegisteredScreenOpener): Promise<AgentScreenPublisher | null> => {
      if (closed || !registration.active) return null
      const existing = publishers.get(registration)
      if (existing) return existing
      if (pending.has(registration)) return null
      const lastFailure = failedAt.get(registration)
      if (lastFailure !== undefined && Date.now() - lastFailure < 5_000) return null
      pending.add(registration)
      try {
        const publisher = await registration.opener(size)
        if (closed || !registration.active) {
          await publisher.close().catch(() => undefined)
          return null
        }
        publishers.set(registration, publisher)
        registration.publishers.add(publisher)
        failedAt.delete(registration)
        return publisher
      } catch {
        failedAt.set(registration, Date.now())
        return null
      } finally {
        pending.delete(registration)
      }
    }

    const initial = await Promise.all([...registered].map(attach))
    if (!initial.some(Boolean)) throw new Error('No live-screen destination could be opened.')

    return {
      publish: (frame) => {
        const current = openers().get(runId) ?? new Set<RegisteredScreenOpener>()
        for (const [registration, publisher] of publishers) {
          if (registration.active && current.has(registration)) publisher.publish(frame)
          else {
            publishers.delete(registration)
            registration.publishers.delete(publisher)
            void publisher.close().catch(() => undefined)
          }
        }
        // A destination may join after the page started casting (for example,
        // the run places a call). Attach it on the next damage frame and seed
        // that destination with the frame that prompted the attachment.
        for (const registration of current) {
          if (publishers.has(registration) || pending.has(registration)) continue
          void attach(registration).then((publisher) => publisher?.publish(frame))
        }
      },
      close: async () => {
        if (closed) return
        closed = true
        await Promise.all(
          [...publishers].map(async ([registration, publisher]) => {
            publishers.delete(registration)
            registration.publishers.delete(publisher)
            await publisher.close().catch(() => undefined)
          }),
        )
      },
    }
  }
}

/**
 * Every cast running for a run. A set rather than one entry because the
 * browser is no longer the only thing that can be on the stage: the desk's own
 * screen casts through the same opener (desk-cast.ts), and a run can have both
 * a page open and a desktop open. Whatever ends the run ends all of them.
 */
function liveCasts(): Map<string, Set<BrowserCast>> {
  return (castRegistry.__bunkhouseBrowserCastsLive ??= new Map())
}

/**
 * Offer to carry this run's screen as live video. Returns the way to withdraw
 * the offer, which also ends every cast already running on it — so a call that
 * ends while the agent still has a page or a desktop open leaves nothing
 * behind, whatever order the teardown happens in.
 */
export function registerBrowserCast(runId: string, opener: AgentScreenOpener): () => Promise<void> {
  const registration: RegisteredScreenOpener = { opener, active: true, publishers: new Set() }
  let registered = openers().get(runId)
  if (!registered) {
    registered = new Set()
    openers().set(runId, registered)
  }
  registered.add(registration)
  let withdrawn = false
  return async () => {
    if (withdrawn) return
    withdrawn = true
    registration.active = false
    registered!.delete(registration)
    await Promise.all([...registration.publishers].map((publisher) => publisher.close().catch(() => undefined)))
    registration.publishers.clear()
    if (registered!.size > 0) return
    openers().delete(runId)
    for (const cast of [...(liveCasts().get(runId) ?? [])]) await cast.stop()
  }
}

/** True when this run's screen is being watched live by somebody. */
export function browserCastWanted(runId: string): boolean {
  return (openers().get(runId)?.size ?? 0) > 0
}

/**
 * The publisher opener registered for this run, or null when nobody is
 * watching. The desk's cast goes through the same door as the browser's, so
 * there is one registry and one lifecycle rather than two that drift.
 */
export function agentScreenOpenerFor(runId: string): AgentScreenOpener | null {
  return fanoutOpener(runId)
}

/** Put a running cast on the run's books, and take it off again. */
export function trackLiveCast(runId: string, cast: BrowserCast): () => void {
  let set = liveCasts().get(runId)
  if (!set) {
    set = new Set()
    liveCasts().set(runId, set)
  }
  set.add(cast)
  return () => {
    const current = liveCasts().get(runId)
    if (!current) return
    current.delete(cast)
    if (current.size === 0) liveCasts().delete(runId)
  }
}

// --- The cursor ------------------------------------------------------------

/**
 * The attribute the cursor's host element carries. Page-side finders skip
 * anything inside it: the agent must never click its own pointer, and the
 * pointer must never turn up in the text a page is summarized to.
 */
export const CURSOR_HOST_ATTR = 'data-bunkhouse-cursor'

/**
 * How long the pointer takes to travel to what is about to be clicked. Short
 * enough to be invisible in the call's pacing, long enough to read as a hand
 * moving rather than a teleport — which is the whole point: a viewer who sees
 * the pointer arrive knows what is about to be pressed before it is.
 */
const CURSOR_LEAD_MS = 220

/**
 * The pointer, as source. Written as a plain string on purpose — it is
 * installed with `evaluateOnNewDocument`, which ships source to Chromium, and
 * a string can never pick up a compiler helper (`__name` and friends) that
 * exists only in this process's bundle.
 *
 * Everything about it is defensive:
 *   · a *closed* shadow root, so page script cannot reach into it and page CSS
 *     cannot leak into it (`all:initial` on the host closes the other
 *     direction — inherited properties);
 *   · hung off `<html>` rather than `<body>`, so it is outside the subtree our
 *     own page summarizer reads text from;
 *   · `position:fixed` with a zero-size host and `pointer-events:none`, so it
 *     contributes no layout, intercepts no input, and cannot change what the
 *     page does — and deliberately no CSS containment on the host, since
 *     layout containment would make it the containing block for the fixed
 *     pointer inside it and paint containment would clip the pointer to a
 *     zero-size box;
 *   · driven by the page's real mouse events, so it shows where the mouse
 *     genuinely is rather than where we believe we put it;
 *   · reduced motion honored — the ripple is decoration.
 */
const CURSOR_SOURCE = `
;(function () {
  if (window.top !== window) return;
  var KEY = '__bunkhouseCursor';
  var HOST_ATTR = '${CURSOR_HOST_ATTR}';

  var install = function () {
    var root = document.documentElement;
    if (!root) return false;
    var live = window[KEY];
    if (live && live.host && live.host.isConnected) return true;
    // A page that replaced its own document element left a pointer behind
    // with two live window listeners on it. Take those down before drawing
    // another, so a hostile or merely enthusiastic page cannot accumulate them.
    if (live && live.detach) live.detach();

    var host = document.createElement('div');
    host.setAttribute(HOST_ATTR, '');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'all:initial;position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483647';
    var shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML =
      '<style>' +
      '.p{position:fixed;left:0;top:0;width:0;height:0;opacity:0;transition:opacity 120ms linear;will-change:transform}' +
      '.p.on{opacity:1}' +
      '.a{position:absolute;left:-2px;top:-2px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}' +
      '.r{position:absolute;left:-15px;top:-15px;width:30px;height:30px;border-radius:50%;' +
      'border:2px solid rgba(37,99,235,.9);background:rgba(37,99,235,.18);opacity:0;transform:scale(.3)}' +
      '.r.press{animation:bhpress 480ms cubic-bezier(.22,1,.36,1) forwards}' +
      '@keyframes bhpress{0%{opacity:.95;transform:scale(.25)}100%{opacity:0;transform:scale(1.6)}}' +
      '@media (prefers-reduced-motion: reduce){.p{transition:none}.r.press{animation:none;opacity:0}}' +
      '</style>' +
      '<div class="p"><div class="r"></div>' +
      '<svg class="a" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">' +
      '<path d="M3 1.6 L3 17.2 L7.1 13.4 L9.6 19.4 L12.4 18.2 L9.9 12.4 L15.4 12.1 Z" ' +
      'fill="#ffffff" stroke="#111827" stroke-width="1.4" stroke-linejoin="round"/></svg>' +
      '</div>';
    root.appendChild(host);

    var pointer = shadow.querySelector('.p');
    var ripple = shadow.querySelector('.r');
    var state = { x: 0, y: 0, placed: false };

    var place = function (x, y) {
      state.x = x;
      state.y = y;
      if (!state.placed) {
        state.placed = true;
        pointer.classList.add('on');
      }
      pointer.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    };

    // Capture, on window: the first thing in the capture path, so a page that
    // stops propagation on its own handlers cannot stop the pointer moving.
    var onMove = function (event) {
      place(event.clientX, event.clientY);
    };
    var onDown = function (event) {
      place(event.clientX, event.clientY);
      ripple.classList.remove('press');
      // Reading offsetWidth restarts the animation; without it a second
      // click on the same spot flashes nothing at all.
      void ripple.offsetWidth;
      ripple.classList.add('press');
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mousedown', onDown, true);
    var detach = function () {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mousedown', onDown, true);
      if (host.parentNode) host.parentNode.removeChild(host);
    };

    /**
     * Lead the pointer to the marked element, bringing it into view on the
     * way. One animation: the page scrolls smoothly while the pointer eases
     * toward wherever the element currently is, so the two arrive together.
     * Resolves false when there is nothing marked to lead to.
     */
    var leadTo = function (attr, ms) {
      return new Promise(function (resolve) {
        var el = document.querySelector('[' + attr + ']');
        if (!el) {
          resolve(false);
          return;
        }
        var box = el.getBoundingClientRect();
        var vh = window.innerHeight || document.documentElement.clientHeight || 0;
        var vw = window.innerWidth || document.documentElement.clientWidth || 0;
        if (box.top < 8 || box.bottom > vh - 8 || box.left < 8 || box.right > vw - 8) {
          try {
            el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
          } catch (scrollError) {
            try {
              el.scrollIntoView();
            } catch (ignored) {}
          }
        }
        var from = { x: state.x, y: state.y };
        // Nothing has moved the mouse on this page yet, so the pointer has no
        // honest place to start from: it appears on the target and then rides
        // it for the rest of the lead, which is what makes the smooth scroll
        // underneath visible rather than instant.
        var seeded = state.placed;
        var startedAt = 0;
        var done = false;
        var finish = function (answer) {
          if (done) return;
          done = true;
          resolve(answer);
        };
        var step = function (now) {
          if (startedAt === 0) startedAt = now;
          var t = ms <= 0 ? 1 : Math.min(1, (now - startedAt) / ms);
          var eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          var rect = el.getBoundingClientRect();
          var tx = rect.left + rect.width / 2;
          var ty = rect.top + rect.height / 2;
          if (!seeded) {
            seeded = true;
            from.x = tx;
            from.y = ty;
          }
          place(from.x + (tx - from.x) * eased, from.y + (ty - from.y) * eased);
          if (t < 1) requestAnimationFrame(step);
          else finish(true);
        };
        requestAnimationFrame(step);
        // A page that is throttled paints no animation frames. The pointer is
        // decoration; it must never be what holds up an action.
        setTimeout(function () {
          finish(true);
        }, ms + 250);
      });
    };

    window[KEY] = { host: host, leadTo: leadTo, detach: detach };
    return true;
  };

  if (!install()) {
    document.addEventListener('DOMContentLoaded', function () {
      install();
    }, { once: true });
  }
})();
`

/**
 * Draw a pointer in this page and keep it drawn. `evaluateOnNewDocument`
 * covers every document the page loads from here on; the `framenavigated`
 * re-install is the safety net for the ones it does not — a document already
 * parsed when the session opened, or one whose install raced the parser. The
 * script itself is idempotent, so re-running it on a page that already has a
 * pointer does nothing.
 */
export async function installAgentCursor(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(CURSOR_SOURCE)
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return
    void page.evaluate(CURSOR_SOURCE).catch(() => {})
  })
  await page.evaluate(CURSOR_SOURCE).catch(() => {})
}

/**
 * Move the pointer onto the element the page-side finders have marked, before
 * the real click or the real typing lands on it — so a viewer sees the intent
 * and then the action, the way they would watching a person work.
 *
 * Absorbs everything. A pointer that fails to move, an element that moved out
 * from under it, a page that is not painting: none of it may change what the
 * agent's action does or whether it happens at all.
 */
export async function leadCursorTo(page: Page, targetAttr: string): Promise<void> {
  // Source rather than a compiled arrow, for the same reason the pointer
  // itself is source, and self-healing: the install re-runs first and returns
  // in microseconds when the pointer is already there, so a page that replaced
  // its whole document element out from under us gets its pointer back on the
  // next action instead of losing it for the rest of the visit.
  const expression = `${CURSOR_SOURCE}
;(window.__bunkhouseCursor ? window.__bunkhouseCursor.leadTo(${JSON.stringify(
    targetAttr,
  )}, ${CURSOR_LEAD_MS}) : false)`
  await page.evaluate(expression).catch(() => {})
}

// --- The screencast --------------------------------------------------------

/** JPEG quality Chromium encodes each screencast frame at. */
const SCREENCAST_QUALITY = 70

/** The shortest gap between two published frames — the frame rate, as a gap. */
const MIN_FRAME_GAP_MS = Math.round(1000 / AGENT_SCREEN_FPS)

/**
 * How long a still page may go without a frame before the last one is sent
 * again. Chromium emits nothing while nothing repaints, which is correct and
 * cheap — but a subscriber that joins during a quiet stretch would have no
 * picture at all until the page next moved. One repeat a second is the floor.
 */
const KEEPALIVE_MS = 1000

/**
 * `VideoFrame` hands the FFI a pointer to the *whole* backing ArrayBuffer, so
 * a view into a larger or offset buffer would be read as the wrong pixels.
 * Node's Buffer is pooled and routinely offset, so check, and copy only when
 * the check fails — which for sharp's own allocations is never.
 */
export function exactBytes(buffer: Buffer): Uint8Array {
  if (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength) {
    return new Uint8Array(buffer.buffer)
  }
  const copy = new Uint8Array(buffer.byteLength)
  copy.set(buffer)
  return copy
}

/**
 * Start casting this page, if a live-view destination was registered for the
 * run. Returns null when the deployment has no realtime transport configured,
 * so the browser still behaves exactly as it did before live observation.
 *
 * The pipeline per frame: Chromium encodes a JPEG on repaint → we ack it
 * immediately (an unacked frame stops the stream) → sharp decodes it and
 * writes packed RGBA at the published size → the publisher captures it. Decode
 * is the only real cost, a handful of milliseconds on libuv's pool rather than
 * on this event loop, and it is capped by the frame gap.
 *
 * Back-pressure is a drop, never a queue: while a conversion is in flight
 * every arriving frame is acked and discarded. A slow encoder therefore lowers
 * the frame rate the caller sees and cannot, at any point, slow the agent
 * down — the agent's work and the picture of it share a process, and only one
 * of them matters.
 */
export async function startBrowserCast(args: { page: Page; runId: string }): Promise<BrowserCast | null> {
  const { page, runId } = args
  const opener = fanoutOpener(runId)
  if (!opener) return null

  const width = AGENT_SCREEN_WIDTH
  const height = AGENT_SCREEN_HEIGHT

  let publisher: AgentScreenPublisher
  try {
    publisher = await opener({ width, height })
  } catch {
    // Publishing is a nicety; a browser session is not failed over it.
    return null
  }

  let cdp: CDPSession | null = null
  let stopped = false
  let converting = false
  let lastPublishedAt = 0
  let lastFrame: AgentScreenFrame | null = null
  let keepalive: ReturnType<typeof setInterval> | null = null

  const send = (frame: AgentScreenFrame) => {
    lastFrame = frame
    lastPublishedAt = Date.now()
    publisher.publish(frame)
  }

  const onFrame = (event: { data: string; sessionId: number }) => {
    // Acked first and unconditionally: Chromium stops the stream until the
    // frame it sent is acknowledged, so a dropped frame must still be acked.
    void cdp?.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
    if (stopped || converting) return
    const now = Date.now()
    if (now - lastPublishedAt < MIN_FRAME_GAP_MS) return
    converting = true
    sharp(Buffer.from(event.data, 'base64'))
      // Anchored top-left rather than centred: a frame that arrives a few
      // pixels off — a page mid-resize — should look like the page shifted,
      // not like the whole view jumped.
      .resize({ width, height, fit: 'contain', position: 'left top', background: '#000000' })
      .ensureAlpha()
      .raw()
      .toBuffer()
      .then((raw) => {
        if (stopped) return
        send({ data: exactBytes(raw), width, height })
      })
      .catch(() => {
        // One frame that would not decode is one frame; the next repaint is
        // the retry, and there is nobody to tell about a dropped pixel.
      })
      .finally(() => {
        converting = false
      })
  }

  try {
    cdp = await page.createCDPSession()
    cdp.on('Page.screencastFrame', onFrame)
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: SCREENCAST_QUALITY,
      maxWidth: width,
      maxHeight: height,
      // Every repaint is offered; the gap above is what actually sets the rate,
      // because an nth-frame filter would also thin out a page that is barely
      // painting at all.
      everyNthFrame: 1,
    })
  } catch (error) {
    await publisher.close().catch(() => {})
    await cdp?.detach().catch(() => {})
    throw error
  }

  const heartbeat = setInterval(() => {
    if (stopped || !lastFrame) return
    if (Date.now() - lastPublishedAt < KEEPALIVE_MS) return
    send(lastFrame)
  }, KEEPALIVE_MS)
  if (typeof heartbeat === 'object' && 'unref' in heartbeat) heartbeat.unref()
  keepalive = heartbeat

  let untrack: () => void = () => {}
  const cast: BrowserCast = {
    stop: async () => {
      if (stopped) return
      stopped = true
      if (keepalive) clearInterval(keepalive)
      keepalive = null
      lastFrame = null
      untrack()
      // The page may already be gone — a closed browser is exactly when this
      // runs — so every step here is allowed to fail without stopping the next.
      await cdp?.send('Page.stopScreencast').catch(() => {})
      cdp?.off('Page.screencastFrame', onFrame)
      await cdp?.detach().catch(() => {})
      cdp = null
      await publisher.close().catch(() => {})
    },
  }
  untrack = trackLiveCast(runId, cast)
  return cast
}
