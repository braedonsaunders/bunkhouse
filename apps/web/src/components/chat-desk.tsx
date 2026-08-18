'use client'

import * as React from 'react'
import Link from 'next/link'
import { EyeOff, Loader2, Maximize2, Minimize2, Monitor, MonitorOff, MousePointer2, ShieldAlert } from 'lucide-react'
import { Badge, Button, EmptyState, cn } from '@braedonsaunders/appkit-ui'
import { AGENT_SCREEN_HEIGHT, AGENT_SCREEN_WIDTH } from '../lib/agent-screen'
import {
  closeDesktopAction,
  deskStatusAction,
  openDesktopAction,
  sendDesktopInputAction,
  setDeskFrameRateAction,
  takeoverAction,
} from '../app/chat/actions'
import { WorkSurfaceFullscreenButton } from './work-surface-fullscreen-button'

/**
 * The agent's desk, beside the conversation: what is on its screen right now,
 * and — when you take the controls — a keyboard and mouse on the same machine.
 *
 * Everything here is the client half of an existing contract, never a second
 * source of truth. The feature gate is the Company → Features switchboard's
 * (`desk`, and `desktop` under it); this pane reports what the gate says and
 * links to it, and never offers a switch of its own. Opening a screen is one
 * button: the session still records who opened it and that a hand did, but the
 * justification §3.17 asks for belongs to the AGENT escalating to the expensive
 * tier, not to an operator opening their own agent's screen in front of them.
 *
 * The two ways to touch the screen are deliberately NOT the same control, and
 * the difference is the whole point of §3.14:
 *
 *   · **Take the controls** drives the desktop through this product's own
 *     door. Every click and every character is recorded on the run record as
 *     an operator step, and the live picture keeps arriving so you can see
 *     what you are doing. This is the ordinary way to help.
 *   · **Private control** is a handover. The guest withholds every frame for
 *     its duration and nothing done inside it is recorded — only that it
 *     happened, who took it, and for how long. It exists for the step nobody
 *     should be recording: a password, a one-time code off somebody's phone.
 *
 * Saying either of those is the other would be a lie an operator could not
 * detect, so the copy on both is exact.
 *
 * The pane is a third of a card, which is enough to watch a machine and not
 * enough to work one, so the same desk can be opened full screen. That is one
 * picture at two SIZES rather than two views, and — since the picture became a
 * `<video>` fed by a MediaSource — that has to be meant literally:
 *
 *   FULL SCREEN IS A CSS STATE ON THE ELEMENT THAT IS ALREADY THERE. Nothing is
 *   re-parented, portalled, or handed to an overlay component.
 *
 * The earlier design moved one input surface between the pane and an appkit
 * `Drawer`. That was harmless while the picture was an `<img>` — a re-created
 * `<img>` with the same `src` simply repaints — and fatal for a `<video>`: a
 * `Drawer` portals to `document.body`, so the surface's position in the React
 * tree changed, React unmounted the old element and created a new one, and the
 * new one had no MediaSource, no SourceBuffer and nobody appending to it. The
 * picture went black on entering full screen and stayed black on leaving it,
 * because nothing in the old design re-established any of that. So the surface
 * now lives at ONE position in the tree for the whole life of an open screen
 * and `showExpanded` only swaps its class list (`fixed inset-0` and a chrome of
 * its own instead of a box in the pane). React reconciles the same element type
 * at the same position, so the DOM node — and the media pipeline hanging off
 * it — survives the transition by construction rather than by luck.
 *
 * The rest is unchanged by the move on purpose: the video stream, the status
 * poll, the driving mode and the typing buffer all live above it, and the
 * coordinate translation is the one `framePoint` reading the element's live box
 * — so a click lands on the same pixel at either size.
 */

/** The desk's answer for one agent, as the server action reports it. */
type DeskStatus = {
  /** False when this deployment has no desk runner at all — infrastructure, not a setting. */
  supported: boolean
  /** The parent feature gate: whether an agent has a machine. */
  desk: boolean
  /** The child gate: whether a screen may be opened on that machine. */
  desktop: boolean
  /** Whether a desktop screen is open on this agent's desk right now. */
  screenRunning: boolean
  /** What the server wants said about any of the above, in plain words. */
  reason?: string | undefined
}

/**
 * One decoded frame: a `data:` URL and nothing else.
 *
 * The size the stream announces is deliberately not carried. Coordinates are
 * quoted against the picture that is actually on screen, so the decoded
 * image's own dimensions are the only ones anything here may translate
 * against — see `framePoint`.
 */
type DeskFrame = { src: string }

/**
 * How often the desk is asked what it is doing. The agent opens and closes its
 * own screen mid-turn, so this pane cannot wait for a person to act: it has to
 * notice a screen that appeared while somebody was reading.
 */
const STATUS_POLL_MS = 5_000

/** How long a still frame stream may go quiet before the "live" dot stands down. */
const FRAME_STALE_MS = 8_000

/** The polling fallback's interval when the frame stream is unavailable. */
const FRAME_POLL_MS = 1_000

/**
 * The runner's video framing (`encodeVideoWireChunk` in
 * apps/web/scripts/desk-runner.mts, mirrored here by hand — change both
 * together): an 8-byte header then a fragmented-MP4 payload.
 *
 *   [magic:2 = 'DV'][kind:1][flags:1][length:4 BE][payload:length]
 *
 * kind 1 is the init segment, whose payload is [codecLength:1][codec][bytes];
 * kind 2 is a media fragment. flags bit 0 marks a keyframe.
 */
const VIDEO_WIRE_HEADER_BYTES = 8
const VIDEO_WIRE_KIND_INIT = 1
const VIDEO_WIRE_KIND_MEDIA = 2

/**
 * How far behind the newest buffered moment the playhead may drift before it is
 * chased, where it is chased back to, and how far behind is far enough to be
 * worth a visible seek.
 *
 * This is THE classic MediaSource live-streaming failure: a `<video>` plays at
 * exactly 1x, every hiccup adds permanently to the gap between the playhead and
 * the live edge, and half an hour later the operator is driving a desktop they
 * are watching four seconds in the past. Nothing about that looks broken — the
 * picture is smooth and the clicks land where they were aimed — which is why it
 * has to be corrected rather than noticed.
 *
 * THE MEASUREMENT THAT SET THESE. Keystroke to picture ON THE WIRE is ~66ms
 * median: the guest and the transport are not what an operator is feeling. What
 * was left was this — the gap between the newest byte the browser holds and the
 * moment it is drawing — and it was allowed to be 350ms, which is five times
 * everything upstream of it put together. So the slack is now a frame or two
 * rather than a third of a second.
 *
 * TIGHTENING IT IS ONLY HALF THE FIX, and on its own it would be a worse view
 * than before: correcting the drift by SEEKING at 120ms means seeking many
 * times a minute, and each seek is a decoder flush — a visible stutter, right
 * where the operator is looking. So the ordinary correction is not a seek at
 * all. It is a small rise in playback rate, held until the playhead has eaten
 * the gap: 8% faster is imperceptible on a picture of a desktop (there is no
 * audio to pitch-shift and no motion whose speed anyone knows) and it converges
 * a 120ms gap in about a second and a half. The seek is kept for the case it is
 * actually good at — a stall of half a second or more, where no survivable rate
 * would catch up in reasonable time and the gap is already obvious.
 *
 * SLACK and TARGET are two numbers rather than one on purpose: coming back to
 * exactly the threshold would have the nudge switch on and off every few
 * frames. Nudging starts above SLACK and stops below TARGET, and in between
 * whatever it was doing continues.
 */
const VIDEO_LIVE_EDGE_SLACK_S = 0.12
const VIDEO_LIVE_EDGE_TARGET_S = 0.05
const VIDEO_LIVE_EDGE_SEEK_S = 0.5
const VIDEO_CATCHUP_RATE = 1.08

/** How much played video to keep buffered. Anything older is memory. */
const VIDEO_BUFFER_KEEP_S = 4

/**
 * How long the encode may go silent before the stream is treated as dead.
 *
 * H.264 at a fixed rate emits a fragment per frame whether or not the desktop
 * repainted — a still screen costs a few dozen bytes, not nothing — so silence
 * is not "the desk is idle", it is "the pipe is gone". The desk suspending and
 * resuming, the runner's pump dying, and a proxy quietly holding the connection
 * open with nothing behind it all look exactly like this and nothing else
 * reports them: the fetch does not fail, the element does not error, the
 * picture simply stops. Generous enough that a slow guest is not mistaken for a
 * dead one.
 */
const VIDEO_SILENCE_MS = 12_000

/**
 * How long an attempt must have been delivering pictures before its next
 * failure is treated as a fresh one rather than as another of the same.
 * Comfortably longer than a reconnect takes, so a stream that is failing in a
 * loop cannot keep buying itself a new budget.
 */
const VIDEO_HEALTHY_MS = 5_000

/**
 * The backoff between attempts to re-open the stream, doubled each time and
 * capped. Short at the start because most breaks are one hiccup and the
 * operator is looking at the screen; capped because a desk that is genuinely
 * gone must not be hammered.
 */
const VIDEO_RECONNECT_BASE_MS = 400
const VIDEO_RECONNECT_MAX_MS = 4_000

/**
 * How many times in a row the stream may be re-opened before the still-picture
 * fallback takes over.
 *
 * Bounded rather than endless, and the terminal state is stills rather than
 * nothing: a browser or a deployment that cannot carry video at all would
 * otherwise reconnect forever behind a "reconnecting" badge, when what the
 * operator needs is the slower picture that does work. The count is consecutive
 * within one live view — a stream that comes back and runs gets the whole
 * budget again, because the failure that matters is the one that will not heal.
 */
const VIDEO_RECONNECT_ATTEMPTS = 5

/**
 * How long to wait before asking again for a capture rate that had nothing to
 * apply to. The only way that happens is the race between this pane's own
 * subscription reaching the runner and the mode changing on top of it, so one
 * beat is the whole of the wait.
 */
const FRAME_RATE_RETRY_MS = 750

/**
 * How long typed characters are gathered before they are sent as one `type`.
 * A round trip per keystroke would put the guest a word behind a fast typist;
 * a sixth of a second is under the threshold where the delay is felt and still
 * collapses ordinary typing into a handful of messages.
 */
const TYPE_FLUSH_MS = 160

/** Two Escapes inside this window hand control back — see the driving note. */
const RELEASE_CHORD_MS = 500

/**
 * How long an Escape that was given to the guest keeps the full-screen view
 * from being closed by that same press.
 *
 * While someone is driving, every Escape belongs to the desktop and the
 * full-screen view refuses the key outright. The press that needs this window
 * is the SECOND of the release chord: it stops driving, and by the time
 * anything asks whether the desktop still owns Escape, it does not — so the one
 * keystroke that handed control back would also collapse the view. This window
 * is what makes those two separate acts: stop driving, then leave.
 */
const GUEST_ESCAPE_GRACE_MS = 250

/** Movement under this many frame pixels between press and release is a click, not a drag. */
const DRAG_THRESHOLD_PX = 4

/**
 * Named keys as the guest's input layer wants them (X11 keysyms), which is the
 * same vocabulary `desktop_key` documents for the agent. Anything not named
 * here and not a single printable character is not forwarded at all — a key
 * nobody can name is a key nobody can predict.
 */
const NAMED_KEYS: Record<string, string> = {
  Enter: 'Return',
  Tab: 'Tab',
  Escape: 'Escape',
  Backspace: 'BackSpace',
  Delete: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'Page_Up',
  PageDown: 'Page_Down',
  Insert: 'Insert',
}

const MOUSE_BUTTONS: Record<number, 'left' | 'middle' | 'right'> = { 0: 'left', 1: 'middle', 2: 'right' }

/**
 * What Tab may reach inside the full-screen view. The same list appkit's own
 * overlays trap on, restated here because this surface cannot BE one of them —
 * see the note at the top: a `<video>` that goes into a portalled panel is a
 * `<video>` that has been re-created, and re-creating it is the whole bug.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Ask the desk what it is doing, with the failure as an ordinary answer. The
 * read is separated from what is done with it so the poll and the controls can
 * share one question without sharing one piece of state-setting code.
 */
async function readDeskStatus(personId: string): Promise<{ status: DeskStatus } | { error: string }> {
  try {
    return { status: await deskStatusAction(personId) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'The desk could not be reached.' }
  }
}

/** The action shapes the desk accepts, as `sendDesktopInputAction` takes them. */
type DesktopInput =
  | { action: 'click'; x: number; y: number; button: 'left' | 'middle' | 'right' }
  | { action: 'type'; text: string }
  | { action: 'key'; combo: string }
  | { action: 'scroll'; x: number; y: number; dx: number; dy: number }
  | { action: 'drag'; from: { x: number; y: number }; to: { x: number; y: number } }

/**
 * Displayed pixels → the frame's own pixel space.
 *
 * The desk contract is one-to-one against the picture it observed: a click at
 * (x, y) is a click at (x, y) on the guest's screen. So every point this pane
 * collects has to be turned back into the pixel it came from before it is
 * sent, and the translation has to come from what is actually on screen —
 * the rendered element's box against the frame's own size — rather than from
 * any assumed scale. Get it wrong and every click lands slightly off, which
 * looks like a flaky desk rather than a broken sum.
 *
 * ONE implementation for both the video view and the still-picture fallback,
 * and for both the pane and the full-screen view — which are the SAME element
 * measured at two sizes, so there is not even a second box for a second copy of
 * this sum to disagree about. Every term comes from the element's live box and
 * the picture's own intrinsic size, so going full screen simply produces a
 * larger scale on the next call and nothing here has to be told it happened.
 * This is the part that breaks silently when a layout changes: a second copy of
 * this sum, drifting from the first, shows up as clicks that land NEAR the
 * target, which reads as a broken desk rather than as a broken sum.
 *
 * The picture is laid out `object-contain`, so:
 *
 *   scale   = min(boxWidth / frameWidth, boxHeight / frameHeight)
 *   drawnW  = frameWidth * scale,  drawnH = frameHeight * scale
 *   originX = (boxWidth - drawnW) / 2,  originY = (boxHeight - drawnH) / 2
 *   frameX  = (clientX - boxLeft - originX) / scale
 *   frameY  = (clientY - boxTop  - originY) / scale
 *
 * The frame's size is read from the DECODED PICTURE — `videoWidth` on a video,
 * `naturalWidth` on an image — and not from what the stream said it would be:
 * the decoded picture is the thing the coordinates are quoted against, and the
 * two disagree the moment a compositor hands back something other than the size
 * it was asked for.
 *
 * A point in the letterbox belongs to no pixel of the frame, so it returns
 * null and nothing is sent.
 */
type DeskViewElement = HTMLImageElement | HTMLVideoElement

/** The intrinsic pixel size of whatever is showing the desk. */
function viewSize(element: DeskViewElement): { width: number; height: number } {
  return element instanceof HTMLVideoElement
    ? { width: element.videoWidth, height: element.videoHeight }
    : { width: element.naturalWidth, height: element.naturalHeight }
}

function framePoint(
  element: DeskViewElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const { width: frameWidth, height: frameHeight } = viewSize(element)
  if (frameWidth === 0 || frameHeight === 0) return null
  const box = element.getBoundingClientRect()
  if (box.width === 0 || box.height === 0) return null
  const scale = Math.min(box.width / frameWidth, box.height / frameHeight)
  const originX = (box.width - frameWidth * scale) / 2
  const originY = (box.height - frameHeight * scale) / 2
  const x = Math.round((clientX - box.left - originX) / scale)
  const y = Math.round((clientY - box.top - originY) / scale)
  if (x < 0 || y < 0 || x >= frameWidth || y >= frameHeight) return null
  return { x, y }
}

/** A wheel event's deltas in pixels, whatever unit the browser reported them in. */
function wheelPixels(event: WheelEvent): { dx: number; dy: number } {
  // DOM_DELTA_LINE (1) and DOM_DELTA_PAGE (2) are reported by Firefox and by
  // some mice; the guest only understands pixels, so they are converted here
  // rather than left to be interpreted differently at either end.
  const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1
  return { dx: Math.round(event.deltaX * factor), dy: Math.round(event.deltaY * factor) }
}

/**
 * The live picture of the desk, as VIDEO.
 *
 * This is the transport that makes the pane feel like a remote desktop. The
 * still-picture stream below ships a whole encoded image per tick — around
 * 500KB at this size — and the link between the guest and the host cannot carry
 * thirty of those a second, so most of what the guest painted never arrived
 * however fast it was asked for. H.264 ships the difference between pictures
 * instead, which on a desktop is close to nothing.
 *
 * The bytes arrive as fragmented MP4 and go straight into a MediaSource, which
 * is why fMP4 was chosen: the browser's own decoder does the work and nothing
 * in this file parses a video codec. Two rules are load-bearing and both fail
 * SILENTLY when broken — a black rectangle, no error, nothing in the console:
 *
 *   1. the init segment must be appended before any fragment, and again
 *      whenever the encoder restarts and sends a new one;
 *   2. the first fragment after that must be a keyframe. The runner holds both
 *      of those, so this appends what it is given in the order it is given it.
 *
 * The codec string comes off the wire rather than being hardcoded: a
 * MediaSource whose declared profile and level disagree with the bytes refuses
 * the buffer, and refuses it quietly.
 *
 * Returns `unavailable` when the browser has no MediaSource, cannot decode
 * H.264, or the stream has failed past its retry budget — the caller falls back
 * to `useDeskFrames` below, which is why that path is still here.
 *
 * IT RECOVERS BY ITSELF, which is the other half of the point. A MediaSource
 * has a great many ways to stop and almost all of them are silent: the source
 * ends or closes, the SourceBuffer errors, the decoder gives up, the HTTP
 * stream is closed by something in the middle, the desk suspends and resumes,
 * the encoder respawns with a different codec. Every one of them leaves a
 * `<video>` showing its last frame forever with nothing in the console, so
 * every one of them is caught here and answered the same way: abandon this
 * attempt, open a NEW stream with a fresh MediaSource and a fresh init segment,
 * and say "reconnecting" while it happens. A live view that cannot survive one
 * hiccup is a live view that is black in front of a customer.
 *
 * There is never more than one stream open. Re-opening is done by bumping
 * `attempt`, which is a dependency of the effect, so React runs this effect's
 * cleanup — which aborts the fetch — before the next one starts. The runner
 * fans one encode out to many subscribers and would not refuse a second, but a
 * second connection is still a second copy of every byte and the sequencing
 * makes it impossible rather than merely unlikely.
 */
type DeskVideoView = {
  /** A picture arrived recently enough to call the view live. */
  live: boolean
  /** Video cannot carry this desk here; the still-picture path should take over. */
  unavailable: boolean
  /** The stream broke and is being re-opened. */
  reconnecting: boolean
}

function useDeskVideo(personId: string, watching: boolean, view: DeskViewElement | null): DeskVideoView {
  const [unavailable, setUnavailable] = React.useState(
    // Read once, at first render: whether this browser has MediaSource at all
    // cannot change, and asking inside the effect would be a setState that
    // cascades a render for an answer that was already knowable.
    () => typeof window !== 'undefined' && typeof window.MediaSource === 'undefined',
  )
  const [receivedAt, setReceivedAt] = React.useState(0)
  /**
   * The retry counter, and the effect's own restart key. Raising `attempt` is
   * the ONLY way this hook re-opens a stream, which is what guarantees the old
   * one has been torn down first.
   */
  const [attempt, setAttempt] = React.useState(0)
  const [reconnecting, setReconnecting] = React.useState(false)
  /**
   * Consecutive failures. A ref rather than state because the retries ARE the
   * effect re-running, so this has to survive them without causing one.
   */
  const failuresRef = React.useRef(0)

  // A new screen — or a new agent, or the far side of a handover — starts with
  // the whole budget: what the bound is counting is failures that will not heal
  // within one live view, not ones from an hour ago. Declared before the
  // subscription effect so it has already run when that one opens its stream on
  // the same commit, and it touches nothing but the ref — the "reconnecting"
  // claim is stood down by the first chunk that arrives, which is the only
  // moment it stops being true.
  React.useEffect(() => {
    failuresRef.current = 0
  }, [personId, watching])

  React.useEffect(() => {
    if (!watching || unavailable) return
    // The element the picture is actually being shown in, taken as a value so
    // that a `<video>` which somehow WERE re-created would re-establish the
    // stream instead of leaving this effect appending into a dead one. It is
    // the same node `framePoint` measures, which is what keeps a click landing
    // on the pixel it was aimed at.
    if (!(view instanceof HTMLVideoElement)) return
    if (typeof window === 'undefined' || typeof window.MediaSource === 'undefined') return
    const video = view

    const abort = new AbortController()
    let stopped = false
    let retry: ReturnType<typeof setTimeout> | null = null
    let watchdog: ReturnType<typeof setInterval> | null = null
    /** When this attempt opened, when the last chunk arrived, and when that was last reported upwards. */
    const openedAt = Date.now()
    let chunkAt = 0
    let reportedAt = 0
    /** Whether this attempt has carried anything at all, for the badge. */
    let carrying = false

    const mediaSource = new MediaSource()
    const objectUrl = URL.createObjectURL(mediaSource)
    video.src = objectUrl

    /** Appends are serialized: a SourceBuffer refuses one while it is updating. */
    const queue: Uint8Array<ArrayBuffer>[] = []
    let buffer: SourceBuffer | null = null
    let codec: string | null = null

    /**
     * This browser cannot carry the desk as video at all. Permanent, so it is
     * NOT retried: the same codec would arrive on the next attempt and be
     * refused the same way.
     */
    const fallBackToStills = (why: string): void => {
      if (stopped) return
      stopped = true
      console.warn(`[desk] the video view fell back to stills: ${why}`)
      setReconnecting(false)
      setUnavailable(true)
    }

    /**
     * The stream broke in a way a fresh one might not. Abandon this attempt and
     * schedule another; when the budget is gone, take the stills path rather
     * than leaving a black rectangle and a spinner in front of somebody.
     */
    const restart = (why: string): void => {
      if (stopped) return
      stopped = true
      abort.abort()
      // A stream that RAN is a stream that can run, so its next failure starts
      // the budget over. "Ran" is a span of delivered pictures rather than a
      // single chunk, deliberately: a runner that hands out one keyframe and
      // dies would otherwise reset the budget every time and be reconnected to
      // forever, which is the loop the bound exists to prevent.
      if (chunkAt !== 0 && chunkAt - openedAt >= VIDEO_HEALTHY_MS) failuresRef.current = 0
      const failures = failuresRef.current
      failuresRef.current = failures + 1
      if (failures >= VIDEO_RECONNECT_ATTEMPTS) {
        console.warn(`[desk] the video view gave up after ${failures} attempts: ${why}`)
        setReconnecting(false)
        setUnavailable(true)
        return
      }
      console.warn(`[desk] re-opening the video stream (attempt ${failures + 1}): ${why}`)
      setReconnecting(true)
      retry = setTimeout(
        () => setAttempt((previous) => previous + 1),
        Math.min(VIDEO_RECONNECT_BASE_MS * 2 ** failures, VIDEO_RECONNECT_MAX_MS),
      )
    }

    const prune = (): void => {
      if (!buffer || buffer.updating || buffer.buffered.length === 0) return
      const keepFrom = video.currentTime - VIDEO_BUFFER_KEEP_S
      if (buffer.buffered.start(0) < keepFrom - 1) {
        try {
          buffer.remove(0, keepFrom)
        } catch {
          // A remove that will not take is not worth failing the view over;
          // the next updateend tries again.
        }
      }
    }

    /**
     * Keep the playhead at the live edge — see VIDEO_LIVE_EDGE_SLACK_S.
     *
     * Unchanged by the full-screen transition on purpose, and it has to be:
     * the element, the MediaSource and this buffer are the same objects on both
     * sides of it, so the playhead is chased at pane size and at full size by
     * the same code with the same numbers. A view that quietly stopped chasing
     * when it got big would drift into a lag nobody could account for.
     */
    const chase = (): void => {
      if (!buffer || buffer.buffered.length === 0) return
      const end = buffer.buffered.end(buffer.buffered.length - 1)
      const behind = end - video.currentTime
      if (behind > VIDEO_LIVE_EDGE_SEEK_S) {
        // Far enough behind that no survivable rate would close it: take the
        // stutter, which is cheaper than the wait.
        video.currentTime = Math.max(0, end - VIDEO_LIVE_EDGE_TARGET_S)
        if (video.playbackRate !== 1) video.playbackRate = 1
        return
      }
      if (behind > VIDEO_LIVE_EDGE_SLACK_S) {
        if (video.playbackRate !== VIDEO_CATCHUP_RATE) video.playbackRate = VIDEO_CATCHUP_RATE
        return
      }
      if (behind <= VIDEO_LIVE_EDGE_TARGET_S && video.playbackRate !== 1) video.playbackRate = 1
      // Between TARGET and SLACK nothing changes — see the note on the
      // constants: that band is the hysteresis that stops the rate flapping.
    }

    const pump = (): void => {
      if (stopped || !buffer || buffer.updating) return
      if (queue.length === 0) return
      // EVERYTHING WAITING GOES IN ONE APPEND. A SourceBuffer takes one append
      // at a time and answers with an `updateend` event, so appending N held
      // fragments one at a time costs N trips through the event loop before the
      // newest picture is decodable — and the newest picture is the only one
      // the operator is waiting for. Fragments concatenate: an fMP4 fragment is
      // a self-contained moof+mdat pair, and a run of them is a valid append.
      const next = queue.length === 1 ? queue[0]! : concatChunks(queue)
      queue.length = 0
      try {
        buffer.appendBuffer(next)
      } catch (error) {
        // Quota is the one failure this attempt can absorb: drop what has
        // already been played and try the same bytes again. Anything else —
        // InvalidStateError from a source that closed under us, most often — is
        // this MediaSource being finished, which a new one fixes.
        if (error instanceof DOMException && error.name === 'QuotaExceededError') {
          queue.unshift(next)
          prune()
          return
        }
        restart(`an append was refused (${describeMediaError(error)})`)
      }
    }

    const openBuffer = (mime: string): boolean => {
      if (!MediaSource.isTypeSupported(mime)) return false
      try {
        buffer = mediaSource.addSourceBuffer(mime)
      } catch {
        return false
      }
      // 'sequence' would have the browser stamp its own timestamps; the
      // encoder's are the ones the fragments were cut on.
      buffer.mode = 'segments'
      buffer.addEventListener('updateend', () => {
        prune()
        chase()
        pump()
      })
      buffer.addEventListener('error', () => restart('the source buffer errored'))
      return true
    }

    const onInit = (payload: Uint8Array): void => {
      const nameLength = payload[0] ?? 0
      const name = new TextDecoder().decode(payload.subarray(1, 1 + nameLength))
      const bytes = new Uint8Array(payload.subarray(1 + nameLength))
      if (!name) return
      if (!buffer) {
        codec = name
        if (!openBuffer(`video/mp4; codecs="${name}"`)) {
          // The browser cannot decode what the guest is producing. A retry
          // would be handed the same codec, so this is the stills path.
          fallBackToStills(`this browser cannot decode ${name}`)
          return
        }
      } else if (name !== codec) {
        // A different codec on the same buffer is not something MediaSource
        // will re-negotiate — but a NEW MediaSource negotiates it from
        // scratch, so this is a reconnect rather than a defeat.
        restart(`the encoder changed codec (${codec} → ${name})`)
        return
      }
      // A re-appended init segment is how MSE is told the stream restarted,
      // so an encoder that respawned continues into the same buffer.
      queue.push(bytes)
      pump()
    }

    /** One chunk landed: the view is alive and is no longer reconnecting. */
    const noteChunk = (): void => {
      const at = Date.now()
      chunkAt = at
      if (!carrying) {
        carrying = true
        setReconnecting(false)
      }
      // At most twice a second. The freshness claim is only ever read against a
      // one-second tick, and a setState per frame is thirty renders a second
      // for a number nothing looks at that closely.
      if (at - reportedAt < 500) return
      reportedAt = at
      setReceivedAt(at)
    }

    const read = async (): Promise<void> => {
      const response = await fetch(`/api/desk/${encodeURIComponent(personId)}/video`, {
        cache: 'no-store',
        signal: abort.signal,
      })
      if (!response.ok || !response.body) throw new Error(`the video stream refused (${response.status})`)
      const reader = response.body.getReader()
      // The header may straddle a read, and so may a payload, so the framing
      // is decoded out of a running buffer rather than out of each chunk.
      let held = new Uint8Array(0)
      for (;;) {
        const { value, done } = await reader.read()
        if (done || stopped) break
        if (!value) continue
        const merged = new Uint8Array(held.length + value.length)
        merged.set(held, 0)
        merged.set(value, held.length)
        held = merged
        for (;;) {
          if (held.length < VIDEO_WIRE_HEADER_BYTES) break
          if (held[0] !== 0x44 || held[1] !== 0x56) throw new Error('the video stream lost its framing')
          const kind = held[2]
          const frame = new DataView(held.buffer, held.byteOffset, held.byteLength)
          const length = frame.getUint32(4)
          const end = VIDEO_WIRE_HEADER_BYTES + length
          if (held.length < end) break
          // Copied into its own ArrayBuffer rather than kept as a view: an
          // append is asynchronous and a view would be pinned to — and read
          // out of — a buffer the next read has already moved past.
          const payload = new Uint8Array(held.subarray(VIDEO_WIRE_HEADER_BYTES, end))
          held = held.subarray(end)
          if (kind === VIDEO_WIRE_KIND_INIT) onInit(payload)
          else if (kind === VIDEO_WIRE_KIND_MEDIA) {
            queue.push(payload)
            pump()
          }
          noteChunk()
        }
      }
    }

    // A live view is never paused. Leaving full screen, a tab coming back to
    // the foreground, or a browser's own power-saving heuristic can all pause
    // a media element, and a paused live view does not announce itself — it
    // shows a perfectly sharp picture of a moment that has passed.
    const onPause = (): void => {
      if (stopped) return
      void video.play().catch(() => undefined)
    }
    const onError = (): void => restart(`the element reported media error ${video.error?.code ?? 'unknown'}`)
    const onSourceEnded = (): void => restart('the media source ended')
    const onSourceClose = (): void => restart('the media source closed')

    const start = (): void => {
      // Muted and inline so nothing needs a click to begin: this is a picture
      // of a machine, not media the operator asked to play.
      video.muted = true
      video.playsInline = true
      // A fresh attempt starts at 1x. The element survives a reconnect, and
      // inheriting the previous attempt's catch-up rate would have the new
      // stream running fast with nothing to catch up to.
      video.playbackRate = 1
      void video.play().catch(() => undefined)
      void read()
        .then(() => restart('the stream closed'))
        .catch((error: unknown) => {
          if (abort.signal.aborted || stopped) return
          restart(describeMediaError(error))
        })
      // The opening counts too: a connection the runner accepted and then never
      // encoded into is exactly as blank as one that stopped, and neither of
      // them reports itself.
      watchdog = setInterval(() => {
        if (stopped) return
        if (Date.now() - (chunkAt === 0 ? openedAt : chunkAt) > VIDEO_SILENCE_MS) {
          restart(chunkAt === 0 ? 'the stream never started' : 'the stream went silent')
        }
      }, 1_000)
    }

    mediaSource.addEventListener('sourceopen', start, { once: true })
    mediaSource.addEventListener('sourceended', onSourceEnded)
    mediaSource.addEventListener('sourceclose', onSourceClose)
    video.addEventListener('pause', onPause)
    video.addEventListener('error', onError)

    return () => {
      // `stopped` first: tearing the element down fires `pause`, `error` and
      // `sourceclose`, none of which are a broken stream when we are the ones
      // breaking it, and every one of which would otherwise book a retry.
      stopped = true
      abort.abort()
      if (retry !== null) clearTimeout(retry)
      if (watchdog !== null) clearInterval(watchdog)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('error', onError)
      mediaSource.removeEventListener('sourceended', onSourceEnded)
      mediaSource.removeEventListener('sourceclose', onSourceClose)
      // Order matters on teardown too: drop the element's hold on the
      // MediaSource before the object URL goes, or Chromium logs a decode
      // error for a source that vanished mid-append.
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(objectUrl)
    }
  }, [attempt, personId, unavailable, view, watching])

  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (receivedAt === 0) return
    const interval = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(interval)
  }, [receivedAt])

  return {
    live: watching && receivedAt > 0 && now - receivedAt < FRAME_STALE_MS,
    unavailable,
    // Nothing is being re-opened when nothing is being watched, and the stills
    // path has its own reconnect once video has stood down.
    reconnecting: reconnecting && watching && !unavailable,
  }
}

/**
 * Join the fragments waiting for one append into a single buffer — see `pump`.
 * Its own ArrayBuffer, because an append is asynchronous and a view onto a
 * buffer the reader has moved past is bytes nobody can promise are still there.
 */
function concatChunks(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0
  for (const part of parts) total += part.length
  const merged = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    merged.set(part, at)
    at += part.length
  }
  return merged
}

/** A media failure in words, for the one console line each of them is worth. */
function describeMediaError(error: unknown): string {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

/**
 * The live picture of the desk, as STILL PICTURES.
 *
 * The fallback for a browser with no MediaSource or no H.264, kept working
 * rather than removed: `useDeskVideo` above is the path a modern browser takes,
 * and this is what is left when it cannot.
 *
 * Server-sent events are the preferred transport here — the runner already
 * pushes frames that way and a still screen costs nothing on it. A deployment
 * whose frame stream is not answering (an older route, a proxy that will not
 * carry SSE) falls back again, to polling the single-frame endpoint, so the
 * pane shows the desk either way. That fallback is chosen on the stream's first
 * failure with nothing yet delivered: a stream that has been working and then
 * drops is a reconnect, which EventSource does by itself.
 *
 * Both paths end at a `data:` URL so the rest of the pane never has to know
 * which one it is looking at, and so no object URL has to be revoked out from
 * under an image that is still decoding it.
 */
function useDeskFrames(personId: string, watching: boolean): { frame: DeskFrame | null; live: boolean } {
  const [frame, setFrame] = React.useState<DeskFrame | null>(null)
  const [receivedAt, setReceivedAt] = React.useState(0)

  React.useEffect(() => {
    if (!watching) return
    let cancelled = false
    let source: EventSource | null = null
    let poll: ReturnType<typeof setInterval> | null = null
    let delivered = false

    const accept = (next: DeskFrame) => {
      if (cancelled) return
      delivered = true
      setFrame(next)
      setReceivedAt(Date.now())
    }

    const startPolling = () => {
      if (cancelled || poll !== null) return
      const fetchFrame = async () => {
        try {
          const response = await fetch(`/api/desk/${encodeURIComponent(personId)}/frame`, { cache: 'no-store' })
          if (!response.ok) return
          const blob = await response.blob()
          const reader = new FileReader()
          reader.onload = () => {
            // A data URL rather than an object URL: the same shape the stream
            // produces, and nothing to revoke out from under an image that is
            // still decoding it.
            if (typeof reader.result === 'string') accept({ src: reader.result })
          }
          reader.readAsDataURL(blob)
        } catch {
          // A missed frame is a missed frame — the next tick is the retry.
        }
      }
      void fetchFrame()
      poll = setInterval(() => void fetchFrame(), FRAME_POLL_MS)
    }

    source = new EventSource(`/api/desk/${encodeURIComponent(personId)}/frames`)
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { png?: unknown }
        if (typeof payload.png !== 'string' || payload.png === '') return
        accept({ src: `data:image/png;base64,${payload.png}` })
      } catch {
        // One frame that will not parse is one frame.
      }
    }
    source.onerror = () => {
      if (delivered) return
      source?.close()
      source = null
      startPolling()
    }

    return () => {
      cancelled = true
      source?.close()
      if (poll !== null) clearInterval(poll)
    }
  }, [personId, watching])

  // "Live" is a claim about the last few seconds, not about a socket being
  // open: a stream that has gone quiet must stop saying the picture is
  // current. The tick only runs while a frame is on screen.
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (receivedAt === 0) return
    const interval = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(interval)
  }, [receivedAt])

  // The last frame is kept but not reported while nothing is being watched:
  // a picture from before a handover began is not what is on that screen now.
  return { frame: watching ? frame : null, live: watching && receivedAt > 0 && now - receivedAt < FRAME_STALE_MS }
}

/** The screen's frame, kept at the desk's shape so nothing moves when a picture arrives. */
function DeskScreenBox({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      style={{ aspectRatio: `${AGENT_SCREEN_WIDTH} / ${AGENT_SCREEN_HEIGHT}` }}
      className={cn('relative w-full overflow-hidden rounded-lg border border-border bg-overlay', className)}
    >
      {children}
    </div>
  )
}

/** An explained off state with the one place the switch actually lives. */
function DeskGate({ title, description }: { title: string; description: string }) {
  return (
    <EmptyState
      icon={<MonitorOff />}
      title={title}
      description={description}
      action={
        <Button asChild size="sm" variant="outline">
          <Link href="/admin/settings?section=features">Open Features</Link>
        </Button>
      }
    />
  )
}

export function ChatDesk({ personId, personName }: { personId: string; personName: string }) {
  const [status, setStatus] = React.useState<DeskStatus | null>(null)
  const [statusError, setStatusError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [controlError, setControlError] = React.useState<string | null>(null)
  const [driving, setDriving] = React.useState(false)
  /** The masked handover, and the runner's TTL-bounded viewer for it. */
  const [handover, setHandover] = React.useState<{ active: boolean; url: string | null }>({
    active: false,
    url: null,
  })
  /**
   * Whether the desk is filling the window rather than sitting in its pane.
   *
   * A CSS state and nothing else. There is no second copy of the view, no
   * overlay component holding the picture, and therefore nothing to hand back
   * and forth — which is exactly why there is no longer a "presence" flag
   * beside this one: the element it used to protect is never moved now.
   */
  const [expanded, setExpanded] = React.useState(false)

  // The three elements this pane addresses directly, held as state rather than
  // in refs so that anything reading them re-runs when they arrive. Native
  // listeners (the wheel) and measurements (`framePoint`) have to be bound to
  // the element that is actually on screen, and a ref read once inside an
  // effect is bound to whatever was there at the time.
  //
  //   · `surface` — the input target that covers the picture.
  //   · `shell`   — the box the surface lives in, which IS the full-screen
  //                 view when it is expanded (see the note at the top).
  //   · `view`    — whichever element is showing the desk: the `<video>` on
  //                 the ordinary path, the `<img>` on the still fallback. One
  //                 value for both, because `framePoint` is one function for
  //                 both and a click has to be translated against the picture
  //                 that is actually on screen.
  //
  // The state setters are passed as the callback refs themselves: they are
  // stable across renders, so React attaches them once instead of detaching
  // and re-attaching — which, on the `<video>`, would be a fresh ref call on
  // every render of a screen that is meant never to move.
  const [surface, setSurface] = React.useState<HTMLDivElement | null>(null)
  const [shell, setShell] = React.useState<HTMLDivElement | null>(null)
  const [view, setView] = React.useState<DeskViewElement | null>(null)

  /** The controls' own re-read, after they have changed something. */
  const refresh = React.useCallback(async () => {
    const answer = await readDeskStatus(personId)
    if ('error' in answer) {
      setStatusError(answer.error)
      return
    }
    setStatus(answer.status)
    setStatusError(null)
    // A screen the agent closed under us takes the driving mode with it, so
    // the next click cannot land on a desktop that is no longer there — and
    // the full-screen view with it, so a screen that comes back later does not
    // come back over the whole window.
    if (!answer.status.screenRunning) {
      setDriving(false)
      setExpanded(false)
    }
  }, [personId])

  // Mounted per agent (the pane is keyed on the person), so there is nothing
  // to reset here — only the poll. The agent opens and closes its own screen
  // mid-turn, so the answer has to be re-asked rather than waited for.
  React.useEffect(() => {
    let cancelled = false
    const tick = async () => {
      const answer = await readDeskStatus(personId)
      if (cancelled) return
      if ('error' in answer) {
        setStatusError(answer.error)
        return
      }
      setStatus(answer.status)
      setStatusError(null)
      if (!answer.status.screenRunning) {
        setDriving(false)
        setExpanded(false)
      }
    }
    void tick()
    const interval = setInterval(() => void tick(), STATUS_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [personId])

  const screenOpen = status?.screenRunning === true
  // Nothing to watch during a handover: the guest withholds every frame for
  // its duration, so holding the stream open would only keep a socket alive
  // to carry silence.
  //
  // EXACTLY ONE subscription per open screen, however the view is arranged.
  // It is asked for here, above both sizes of the view, and it depends on
  // nothing that changes when the desk fills the window — so expanding cannot
  // open a second stream and cannot tear this one down. Both would be visible:
  // the runner fans one encode out to many subscribers, so a second connection
  // is a second copy of every byte, and dropping the last subscriber stops the
  // guest's encoder outright, which puts a black rectangle and a wait for the
  // next keyframe at the exact moment somebody has made the desk big enough to
  // work in.
  const watching = screenOpen && !handover.active
  // Video is the ordinary path; stills are subscribed to only once video has
  // reported that this browser cannot carry it, so the guest is never asked to
  // run both encoders at once.
  const {
    live: videoLive,
    unavailable: videoUnavailable,
    reconnecting,
  } = useDeskVideo(personId, watching, view)
  const { frame, live: frameLive } = useDeskFrames(personId, watching && videoUnavailable)
  const live = videoUnavailable ? frameLive : videoLive

  /**
   * Input is queued rather than fired: a `type` that overtakes the click that
   * focused the field lands in the wrong window, and characters that overtake
   * each other land as an anagram. One chain, in the order the person made
   * them, is the only ordering the guest can be given.
   */
  const queueRef = React.useRef<Promise<void>>(Promise.resolve())
  const sendInput = React.useCallback(
    (action: DesktopInput) => {
      queueRef.current = queueRef.current.then(async () => {
        try {
          const result = await sendDesktopInputAction(personId, action)
          setControlError('error' in result ? result.error : null)
        } catch (error) {
          setControlError(error instanceof Error ? error.message : 'That input did not reach the desk.')
        }
      })
    },
    [personId],
  )

  // Typed characters, gathered and then sent as one. The buffer is flushed
  // ahead of anything that is not a character so the guest never sees a
  // Return arrive before the line it was meant to end.
  const bufferRef = React.useRef('')
  const flushRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushTyping = React.useCallback(() => {
    if (flushRef.current !== null) {
      clearTimeout(flushRef.current)
      flushRef.current = null
    }
    const text = bufferRef.current
    bufferRef.current = ''
    if (text !== '') sendInput({ action: 'type', text })
  }, [sendInput])

  const pushCharacter = React.useCallback(
    (character: string) => {
      bufferRef.current += character
      if (flushRef.current !== null) clearTimeout(flushRef.current)
      flushRef.current = setTimeout(flushTyping, TYPE_FLUSH_MS)
    },
    [flushTyping],
  )

  // Driving is a mode of this pane, not a server-side state: every input it
  // forwards goes through the recorded door, so there is nothing to open and
  // nothing to leave open. Stopping simply stops sending — after the typing
  // buffer has been emptied, so a half-typed word is not swallowed.
  const stopDriving = React.useCallback(() => {
    flushTyping()
    setDriving(false)
  }, [flushTyping])

  // A handover is never left running behind a closed pane or a switched agent:
  // for as long as one is open, the agent's own frames are withheld. The flag
  // is written where the handover is actually begun and ended — never during
  // render — so the unmount path reads the last thing that really happened.
  const handoverRef = React.useRef(false)
  const endHandover = React.useCallback(async () => {
    handoverRef.current = false
    setHandover({ active: false, url: null })
    try {
      await takeoverAction(personId, false)
    } catch {
      // The runner revokes the handover on its own TTL as well; a failed
      // hand-back must never leave this pane claiming a screen is masked when
      // it has stopped saying so.
    }
  }, [personId])

  React.useEffect(
    () => () => {
      if (handoverRef.current) void takeoverAction(personId, false).catch(() => undefined)
    },
    [personId],
  )

  // Driving is only real while there is a screen to drive and no handover
  // masking it. Deriving that rather than correcting the flag afterwards is
  // what keeps a click from being sent at a desktop that has already gone.
  const drivingNow = driving && screenOpen && !handover.active

  /**
   * TAKING THE CONTROLS OPENS THE DESK FULL SCREEN.
   *
   * Somebody who has just taken a real desktop's mouse and keyboard is going to
   * work in it, and working in a pane-sized picture of a 1280x900 screen means
   * aiming at targets a third of their real size. Making that a second, manual
   * step is asking the operator to do something they always want done.
   *
   * ONE-WAY, deliberately. Stopping driving does NOT bring the desk back to its
   * pane: watching full screen is a perfectly good thing to be doing, and
   * shrinking the window out from under somebody because they handed the mouse
   * back would be the view deciding what they meant. The way out stays what it
   * always was — the button in the header, the button in the footer, Escape,
   * Shift+F — and every one of them still works.
   *
   * The control handler expands in the same state transition that begins
   * driving. The control is only offered for an open screen, so the full-window
   * layer can never open over an empty desk.
   *
   * This is a CSS state and nothing more (see `expanded`): the `<video>`, its
   * MediaSource and its SourceBuffer are the same objects on both sides of the
   * transition, so nothing is re-parented and nothing goes blank.
   */
  // Focus is what makes the keyboard live, so it is taken for the person
  // rather than left as a step they have to guess at when they take the
  // controls. Nothing competes for it across the full-screen transition any
  // more — the surface is not re-parented, so it simply keeps the focus it
  // had — but a fresh drive still has to begin somewhere.
  React.useEffect(() => {
    if (!drivingNow || !surface) return
    const timer = setTimeout(() => surface.focus(), 0)
    return () => clearTimeout(timer)
  }, [drivingNow, surface])

  /**
   * The rate the desk is captured at follows the mode, on the same flag the
   * input surface uses.
   *
   * Driving is a control loop with a person in it: the guest's own cursor is
   * not in the picture, so the only pointer they can see is their own, and the
   * desktop under it has to keep up with their hand. Watching is a glance, and
   * a glance does not need to be paid for at the driving rate on a machine
   * that is also doing the agent's work.
   *
   * This is a side call, NOT a re-subscription: the frame stream above is left
   * alone and only the guest's capture changes speed, so the picture never
   * blinks out at the moment somebody reaches for the controls. It re-tunes
   * what is running and starts nothing — which is why the one case it retries
   * is the race where this asks before its own subscription has reached the
   * runner and there is not yet a capture to re-tune.
   */
  React.useEffect(() => {
    if (!screenOpen || handover.active) return
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | null = null
    const ask = async () => {
      try {
        const result = await setDeskFrameRateAction(personId, drivingNow)
        if (cancelled || 'error' in result || result.streaming) return
        retry = setTimeout(() => void ask(), FRAME_RATE_RETRY_MS)
      } catch {
        // The picture keeps arriving at whatever rate it already had, so a
        // failure here is worth no words in front of the operator: it is a
        // slower desk, not a broken one.
      }
    }
    void ask()
    return () => {
      cancelled = true
      if (retry !== null) clearTimeout(retry)
    }
  }, [drivingNow, handover.active, personId, screenOpen])

  // A screen that has gone takes the full-screen view with it: there is
  // nothing left to fill a window with, and a full-viewport layer over a closed
  // desktop is a wall in front of the conversation. Derived from the screen
  // rather than corrected after the fact — the same reason `drivingNow` is.
  const showExpanded = expanded && screenOpen

  /** The moment an Escape was handed to the guest — see GUEST_ESCAPE_GRACE_MS. */
  const guestEscapeAtRef = React.useRef(0)

  const expand = React.useCallback(() => setExpanded(true), [])

  const collapse = React.useCallback(() => {
    // Driving is not stopped on the way out: the pane drives too, and yanking
    // the controls away because a view got smaller would lose whatever was
    // half-done. What is refused is the Escape that belonged to the desktop.
    if (Date.now() - guestEscapeAtRef.current < GUEST_ESCAPE_GRACE_MS) return
    setExpanded(false)
  }, [])

  // A key for it, so the operator who is about to work in the desk does not
  // have to go to the mouse to make it big enough to work in. Deliberately
  // narrow: nothing while the keys belong to the guest, nothing while a field
  // has focus, and nothing when there is no screen to show.
  React.useEffect(() => {
    if (!screenOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key.toLowerCase() !== 'f') return
      if (drivingNow) return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        return
      }
      event.preventDefault()
      if (showExpanded) collapse()
      else expand()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [collapse, drivingNow, expand, screenOpen, showExpanded])

  /**
   * Escape leaves the full-screen view — unless the desktop owns it.
   *
   * On `document` rather than on the shell because a click on the letterbox
   * leaves focus on the body, and a way out that depends on where focus
   * happens to be is not a way out. While somebody is driving, the surface's
   * own handler stops the event before it ever reaches here AND this refuses it
   * anyway: the key belongs to the guest, and the release chord's second press
   * is covered by the stamp `collapse` reads.
   */
  React.useEffect(() => {
    if (!showExpanded) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || drivingNow) return
      event.preventDefault()
      collapse()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [collapse, drivingNow, showExpanded])

  /**
   * The rest of the modal semantics the `Drawer` used to supply, on the shell
   * that already holds the picture — because the picture cannot go into a
   * `Drawer` without being re-created (see the note at the top of this file).
   *
   * Focus moves in when the view opens and back to whatever opened it when it
   * closes. Only when it is not already inside: the surface lives in this same
   * shell at both sizes, so somebody who was driving in the pane keeps the
   * keyboard they were driving with rather than having it taken and given back.
   *
   * Scroll is deliberately NOT locked. The application shell is `h-screen
   * overflow-hidden`, so the document does not scroll at all, and a second,
   * uncounted lock on `document.body` would fight appkit's ref-counted one the
   * first time any other overlay opened.
   */
  React.useEffect(() => {
    if (!showExpanded || !shell) return
    const restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!shell.contains(document.activeElement)) shell.focus()
    return () => {
      if (restoreTo && restoreTo.isConnected) restoreTo.focus()
    }
  }, [shell, showExpanded])

  /**
   * Tab stays inside the full-screen view, so the controls under it cannot be
   * reached by a keyboard that is looking at something else.
   *
   * A React handler on the shell rather than a document listener, which gets
   * the driving case for free: while the keys belong to the guest the surface
   * stops propagation, so this never sees the Tab it would otherwise have
   * stolen from the desktop.
   */
  const onShellKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!showExpanded || event.key !== 'Tab' || !shell) return
    const focusable = Array.from(shell.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (element) => element.offsetParent !== null || element === document.activeElement,
    )
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!first || !last) {
      event.preventDefault()
      shell.focus()
      return
    }
    const active = document.activeElement
    if (event.shiftKey && (active === first || !shell.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const toggleDriving = () => {
    if (driving) {
      stopDriving()
      return
    }
    setControlError(null)
    setExpanded(true)
    setDriving(true)
  }

  const toggleHandover = async () => {
    setBusy(true)
    setControlError(null)
    try {
      if (handover.active) {
        await endHandover()
      } else {
        // Driving and a handover are mutually exclusive: one records, the
        // other is masked, and an input arriving from this pane in the middle
        // of a masked session would put a recorded keystroke inside a session
        // whose whole purpose is that there are none.
        stopDriving()
        const result = await takeoverAction(personId, true)
        if ('error' in result) setControlError(result.error)
        else {
          handoverRef.current = result.active
          setHandover({ active: result.active, url: result.url ?? null })
        }
      }
    } catch (error) {
      setControlError(error instanceof Error ? error.message : 'Control could not be changed.')
    } finally {
      setBusy(false)
    }
  }

  const openDesktop = async () => {
    setBusy(true)
    setControlError(null)
    try {
      const result = await openDesktopAction(personId)
      if ('error' in result) setControlError(result.error)
      else await refresh()
    } catch (error) {
      setControlError(error instanceof Error ? error.message : 'The screen could not be opened.')
    } finally {
      setBusy(false)
    }
  }

  const closeDesktop = async () => {
    setBusy(true)
    try {
      stopDriving()
      if (handover.active) await endHandover()
      const result = await closeDesktopAction(personId)
      if ('error' in result) setControlError(result.error)
      else await refresh()
    } catch (error) {
      setControlError(error instanceof Error ? error.message : 'The screen could not be closed.')
    } finally {
      setBusy(false)
    }
  }

  // The wheel is a native listener because it has to be cancellable: React's
  // own wheel handling is passive, and a page that scrolls under the pointer
  // while the guest is being scrolled is unusable.
  const scrollRef = React.useRef({ dx: 0, dy: 0, x: 0, y: 0, timer: null as ReturnType<typeof setTimeout> | null })
  React.useEffect(() => {
    // Bound to the elements themselves rather than to refs read once, so a
    // surface or a picture that were ever replaced would carry the listener
    // and the measurement with them instead of silently leaving both behind.
    if (!surface || !view || !drivingNow) return
    const element = surface
    const state = scrollRef.current
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const point = framePoint(view, event.clientX, event.clientY)
      if (!point) return
      const { dx, dy } = wheelPixels(event)
      state.dx += dx
      state.dy += dy
      state.x = point.x
      state.y = point.y
      if (state.timer !== null) return
      // Accumulated and sent on a short beat: a trackpad emits wheel events
      // far faster than any input channel should carry them, and the guest
      // only cares about the total distance.
      state.timer = setTimeout(() => {
        state.timer = null
        const batch = { dx: state.dx, dy: state.dy }
        state.dx = 0
        state.dy = 0
        if (batch.dx !== 0 || batch.dy !== 0) {
          sendInput({ action: 'scroll', x: state.x, y: state.y, dx: batch.dx, dy: batch.dy })
        }
      }, 80)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', onWheel)
      if (state.timer !== null) {
        clearTimeout(state.timer)
        state.timer = null
      }
    }
  }, [drivingNow, sendInput, surface, view])

  const pressRef = React.useRef<{ x: number; y: number; button: 'left' | 'middle' | 'right' } | null>(null)
  const escapeRef = React.useRef(0)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drivingNow || !view) return
    const point = framePoint(view, event.clientX, event.clientY)
    if (!point) return
    event.preventDefault()
    surface?.focus()
    pressRef.current = { ...point, button: MOUSE_BUTTONS[event.button] ?? 'left' }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const press = pressRef.current
    pressRef.current = null
    if (!drivingNow || !press || !view) return
    event.preventDefault()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    // Anything typed so far belongs before the pointer lands, or it arrives in
    // whatever the click focused instead.
    flushTyping()
    const point = framePoint(view, event.clientX, event.clientY)
    // A release that left the picture still ended a gesture that started
    // inside it: the press point is the honest fallback.
    const to = point ?? press
    const moved = Math.abs(to.x - press.x) >= DRAG_THRESHOLD_PX || Math.abs(to.y - press.y) >= DRAG_THRESHOLD_PX
    if (moved) sendInput({ action: 'drag', from: { x: press.x, y: press.y }, to: { x: to.x, y: to.y } })
    else sendInput({ action: 'click', x: press.x, y: press.y, button: press.button })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!drivingNow) return
    const { key } = event
    if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') return
    event.preventDefault()
    event.stopPropagation()

    if (key === 'Escape') {
      const at = Date.now()
      const second = at - escapeRef.current < RELEASE_CHORD_MS
      escapeRef.current = second ? 0 : at
      // Both Escapes of the pair are the desktop's, so neither may also be
      // read as "close the full-screen view" — the stamp is what `collapse`
      // refuses on, and it is the second press that needs it (the first is
      // still refused by `drivingNow`, which is true until this one lands).
      guestEscapeAtRef.current = at
      // The first Escape still goes to the guest — an Escape that does nothing
      // for half a second would make dialogs unclosable. The second one, in
      // quick succession, is the way out of the pane for someone whose keys are
      // all going to another machine.
      if (second) {
        stopDriving()
        return
      }
    }

    // Cmd is folded into Ctrl on purpose: the guest is Linux, and a person on
    // a Mac presses Cmd+C expecting a copy — not a Super chord no application
    // over there is bound to.
    const control = event.ctrlKey || event.metaKey
    const chord = [control ? 'ctrl' : null, event.altKey ? 'alt' : null].filter((part): part is string => part !== null)

    if (key.length === 1) {
      if (chord.length === 0) {
        // Shift is already in the character the browser gave us — carrying it
        // as a modifier too would type a capital and then shift-capital it.
        pushCharacter(key)
        return
      }
      flushTyping()
      const parts = [...chord, ...(event.shiftKey ? ['shift'] : []), key.toLowerCase()]
      sendInput({ action: 'key', combo: parts.join('+') })
      return
    }

    const named = NAMED_KEYS[key] ?? (/^F([1-9]|1[0-2])$/.test(key) ? key : null)
    if (named === null) return
    flushTyping()
    const parts = [...chord, ...(event.shiftKey ? ['shift'] : []), named]
    sendInput({ action: 'key', combo: parts.join('+') })
  }

  // What the desk is doing, in one word. The same badge stands in the pane's
  // header and in the full-screen header — a screen that is masked or being
  // driven must say so wherever it is being looked at.
  const statusBadge = screenOpen ? (
    <Badge variant={handover.active ? 'info' : drivingNow ? 'warning' : 'success'} className="shrink-0">
      {handover.active ? 'private control' : drivingNow ? 'you are driving' : 'screen open'}
    </Badge>
  ) : null

  // One line, the same twelve-rem-high rule the conversation and the thread
  // list carry: the three panes share one card now, so their headers have to
  // sit on one line across it. What the desk IS gets said in the body, where
  // there is room for it.
  const header = (
    <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface px-4">
      <span className="truncate text-sm font-medium text-fg">{personName}&apos;s desk</span>
      <span className="flex shrink-0 items-center gap-1.5">
        {statusBadge}
        {screenOpen ? (
          <WorkSurfaceFullscreenButton
            expanded={showExpanded}
            onToggle={showExpanded ? collapse : expand}
            surface="desktop"
            shortcut="Shift F"
          />
        ) : null}
      </span>
    </header>
  )

  /**
   * The picture and the input target: ONE element tree, rendered at ONE place
   * in this component for as long as a screen is open.
   *
   * Not "one of two", and not "written once and used twice" — literally one,
   * and it never moves. Everything below hangs off that: the `<video>` keeps
   * its MediaSource across a full-screen transition because React has no
   * reason to unmount it, there is only ever one element competing for the
   * view state, and `framePoint` measures whichever element that is against
   * its own live box, so a click lands on the same pixel at either size.
   */
  const liveScreen = (
    // The surface is the input target, not the picture: it keeps its box
    // whether or not a frame has arrived, so focus, the ring, and the pointer
    // maths never move when one does.
    <div
      ref={setSurface}
      tabIndex={drivingNow ? 0 : -1}
      role={drivingNow ? 'application' : undefined}
      aria-label={drivingNow ? `${personName}'s desktop — your keyboard and mouse are on it` : undefined}
      // While the desk is full screen and being driven, the desktop owns
      // Escape, and this declares that to anything else that might answer it.
      // This view's own handler refuses the key on `drivingNow` directly —
      // it does not read this attribute — but appkit's dialogs and drawers DO,
      // and one of them opening over a driven desktop must not be closed by a
      // keystroke that was meant for the guest.
      data-ui-overlay={showExpanded && drivingNow ? 'desk-driving' : undefined}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onContextMenu={(event) => {
        if (drivingNow) event.preventDefault()
      }}
      onBlur={() => flushTyping()}
      // The ORDINARY ARROW while driving, deliberately. The guest's own pointer
      // is not in the picture — the capture composites no cursor, by design, so
      // there are never two pointers a frame's latency apart — which makes the
      // local one the only pointer the operator has, and it has to read as the
      // pointer of the desktop it is pointing at. A
      // crosshair says "drag out a region", which is not what this is: it is a
      // desktop you click on. Watching is marked by the warning ring and the
      // badge rather than by a cursor, so the picture is never dressed up as
      // something to interact with when it is not.
      className={cn('absolute inset-0 outline-none', drivingNow && 'cursor-default')}
    >
      {handover.active ? (
        <div className="flex size-full flex-col items-center justify-center gap-2 px-8 text-center">
          <EyeOff aria-hidden className="size-6 text-fg-subtle" />
          <p className="text-sm text-fg-muted">
            The picture is withheld while you have private control. That is the point of it — nothing on this screen
            reaches {personName}&apos;s context or the record until you hand it back.
          </p>
        </div>
      ) : !videoUnavailable ? (
        // The desk as video. Muted, inline and autoplaying because this is a
        // picture of a machine rather than media anyone asked to play, and
        // `controls` is deliberately absent: there is nothing to seek in a
        // live view and a scrub bar over a desktop invites exactly the wrong
        // gesture. `object-contain` keeps the desk's own shape at any size —
        // the letterbox is the backdrop behind it, and `framePoint` knows a
        // click that lands there belongs to no pixel.
        //
        // Kept mounted whether or not a picture has arrived, and — the reason
        // this whole file was rearranged — kept mounted across the full-screen
        // transition: the MediaSource, its SourceBuffer and the reader feeding
        // it all hang off THIS node, and React re-creating it destroys every
        // one of them with nothing left to notice or repair the loss.
        <video
          ref={setView}
          aria-label={`${personName}'s desktop`}
          muted
          autoPlay
          playsInline
          disablePictureInPicture
          className="size-full select-none object-contain"
        />
      ) : frame ? (
        // The still-picture fallback. A plain <img>: the frame arrives as a
        // data URL and there is nothing for an image optimizer to do with one.
        // The src is swapped in place rather than the element being keyed, so
        // the browser holds the last frame until the next has decoded and a
        // live screen never blinks white between them.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={setView}
          src={frame.src}
          alt={`${personName}'s desktop`}
          draggable={false}
          className="size-full select-none object-contain"
        />
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-2 text-center">
          <Loader2 aria-hidden className="size-5 animate-spin text-fg-subtle" />
          <p className="px-8 text-sm text-fg-muted">
            The screen is open. Waiting for the first frame — a desktop that is not repainting sends nothing.
          </p>
        </div>
      )}
    </div>
  )

  /**
   * Whether the picture on screen is current, said over the picture itself.
   *
   * Three states rather than two, because a stream that has dropped and a
   * desktop that is not repainting look identical and are not the same thing.
   * "Reconnecting" is a corner badge and a spinner rather than a dialog or a
   * cleared picture: the last frame is still the best guess at what is on that
   * machine, and whipping it away to say so would be a worse view of the desk
   * than a slightly stale one with a note on it.
   */
  const liveBadge = handover.active ? null : (
    <span
      role="status"
      className="pointer-events-none absolute right-2 top-2 flex items-center gap-1.5 rounded-full border border-border bg-surface/90 px-2 py-1 text-xs font-medium text-fg-muted backdrop-blur"
    >
      {reconnecting ? (
        <Loader2 aria-hidden className="size-3 animate-spin text-fg-subtle" />
      ) : (
        <span
          aria-hidden
          className={cn('inline-block size-1.5 rounded-full', live ? 'animate-pulse bg-primary' : 'bg-fg-subtle')}
        />
      )}
      {reconnecting ? 'Reconnecting…' : live ? 'Live' : 'Waiting for a repaint'}
    </span>
  )

  /**
   * What is true of this screen right now, in the words that matter: a masked
   * handover and a recorded drive are never described in the same terms, and
   * the full-screen view says which key does what while the keyboard is not
   * the browser's to spend.
   */
  const notice = handover.active ? (
    <div
      role="status"
      className="space-y-1 rounded-lg border border-primary/40 bg-primary-subtle px-3 py-2 text-xs text-fg"
    >
      <p className="font-medium">You have private control of this desktop.</p>
      <p className="text-fg-muted">
        Nothing you do inside it is recorded and no frame leaves the machine — only that control was handed over, to
        you, and for how long. It expires on its own; hand it back as soon as the private step is done.
      </p>
      {handover.url !== null ? (
        <Button asChild size="sm" variant="outline" className="mt-1">
          <a href={handover.url} target="_blank" rel="noreferrer">
            Open the private screen
          </a>
        </Button>
      ) : (
        <p className="text-fg-muted">
          The screen for it is on the desk runner and is reachable from the network the runner is on.
        </p>
      )}
    </div>
  ) : drivingNow ? (
    <div
      role="status"
      className="space-y-1 rounded-lg border border-warning/40 bg-warning-subtle px-3 py-2 text-xs text-fg"
    >
      <p className="font-medium">You are driving this desktop.</p>
      <p className="text-fg-muted">
        Your clicks, typing, and scrolling go to {personName}&apos;s machine, and every one of them lands on the run
        record as your step — including what you type. For something that must not be recorded, use private control
        instead. Press Escape twice to stop driving.
        {showExpanded
          ? ' While you are driving, Escape belongs to the desktop and full screen stays open — leave it with the' +
            ' button, or once you have stopped.'
          : ''}
      </p>
    </div>
  ) : (
    <p className="text-xs text-fg-muted">
      Watching only. Take the controls to work {personName}&apos;s desktop yourself — on the record, like any other
      step.
      {showExpanded ? ' Escape leaves full screen.' : ''}
    </p>
  )

  /**
   * The two ways to touch the screen, and the way to close it. They keep their
   * exact words wherever they are shown: "take the controls" is the recorded
   * door, "private control" is the masked handover, and no size of view is
   * allowed to blur that.
   */
  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant={drivingNow ? 'default' : 'outline'}
        size="sm"
        aria-pressed={drivingNow}
        disabled={busy || handover.active}
        onClick={toggleDriving}
      >
        <MousePointer2 aria-hidden className="size-4" />
        {drivingNow ? 'Stop driving' : 'Take the controls'}
      </Button>
      <Button
        type="button"
        variant={handover.active ? 'default' : 'outline'}
        size="sm"
        aria-pressed={handover.active}
        disabled={busy}
        onClick={() => void toggleHandover()}
      >
        {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <EyeOff aria-hidden className="size-4" />}
        {handover.active ? 'Hand the screen back' : 'Private control'}
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void closeDesktop()}>
        <MonitorOff aria-hidden className="size-4" />
        Close desktop
      </Button>
      {showExpanded ? (
        <Button type="button" variant="outline" size="sm" onClick={collapse}>
          <Minimize2 aria-hidden className="size-4" />
          Leave full screen
        </Button>
      ) : null}
    </div>
  )

  let body: React.ReactNode
  if (statusError !== null) {
    body = (
      <EmptyState
        icon={<ShieldAlert />}
        title="The desk could not be reached"
        description={statusError}
        action={
          <Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>
            Try again
          </Button>
        }
      />
    )
  } else if (status === null) {
    body = (
      <div className="flex items-center gap-2 py-10 text-sm text-fg-muted">
        <Loader2 aria-hidden className="size-4 animate-spin" />
        Checking {personName}&apos;s desk…
      </div>
    )
  } else if (!status.supported) {
    body = (
      <EmptyState
        icon={<MonitorOff />}
        title="Agent desks are not available on this installation"
        description={
          status.reason ??
          'This deployment has no desk runner, so no agent has a machine to work on. Everything else about the conversation is unaffected.'
        }
      />
    )
  } else if (!status.desk) {
    body = (
      <DeskGate
        title="Agent desks are off"
        description={
          status.reason ??
          'The machine is withheld everywhere — abilities, navigation, and this pane — until the feature is switched on in Company → Features. Recorded sessions stay readable.'
        }
      />
    )
  } else if (!status.desktop) {
    body = (
      <DeskGate
        title="The desktop screen is off"
        description={
          status.reason ??
          `${personName} has a machine, but opening a screen on it is switched off in Company → Features. Shell and browser work continue without one.`
        }
      />
    )
  } else if (!screenOpen) {
    body = (
      <div className="space-y-4">
        <DeskScreenBox className="border-dashed bg-bg-subtle">
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center">
            <Monitor aria-hidden className="size-6 text-fg-subtle" />
            <p className="text-sm text-fg-muted">
              No screen is open on {personName}&apos;s desk. {personName} opens one when GUI work needs it — or you can
              open one here.
            </p>
          </div>
        </DeskScreenBox>
        <Button type="button" disabled={busy} onClick={() => void openDesktop()}>
          {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Monitor aria-hidden className="size-4" />}
          Open desktop
        </Button>
        <p className="text-xs text-fg-muted">
          This is the machine {personName} works on, and everything done here is on their run record. A screen is the
          expensive tier, so the session records that you opened this one; it stays readable in Settings → Desk.
        </p>
      </div>
    )
  } else {
    // The open screen is NOT part of this chain. It is rendered below, in a
    // slot of its own that holds nothing else, so no change of status can
    // reconcile something else into the position the picture lives at.
    body = null
  }

  /**
   * The open screen, at whichever size it is being looked at.
   *
   * Read this as one element with two class lists, because that is exactly what
   * it is. `shell` is the box: in the pane it is the desk-shaped screen box, at
   * full size it is a `fixed inset-0` modal with its own header and footer. The
   * picture area inside it, the surface inside that, and the `<video>` inside
   * that are the same nodes in both — the same positions in the same parents,
   * so React has nothing to unmount and the media pipeline is untouched by the
   * transition.
   *
   * `fixed` is viewport-relative here because nothing between this and `<body>`
   * establishes a containing block — no `transform`, no `filter`, no
   * `contain` — and `z-[60]` is comparable with appkit's overlays for the same
   * reason: no ancestor opens a stacking context either. Both are worth knowing
   * if the chat page's chrome is ever rebuilt.
   */
  const liveBlock = (
    <div>
      {/* The pane keeps saying where the desk went while it is filling the
          window. `space-y-*` is deliberately not used on this wrapper: it puts
          a margin on its children, and a margin on a `fixed inset-0` element
          is resolved against the insets — which would inset the "full" screen
          by three quarters of a rem. */}
      {showExpanded ? (
        <div className="space-y-4">
          <DeskScreenBox className="border-dashed bg-bg-subtle">
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center">
              <Maximize2 aria-hidden className="size-6 text-fg-subtle" />
              <p className="text-sm text-fg-muted">
                {personName}&apos;s desktop is filling the window. Nothing has been closed — the screen, the controls
                and the record are all in there.
              </p>
            </div>
          </DeskScreenBox>
          <Button type="button" variant="outline" onClick={collapse}>
            <Minimize2 aria-hidden className="size-4" />
            Bring the desk back to this pane
          </Button>
        </div>
      ) : null}

      <div
        ref={setShell}
        // Focusable but not tabbable: the full-screen view has to be able to
        // hold the keyboard when nothing inside it has taken it, and must not
        // become a tab stop in the pane.
        tabIndex={-1}
        role={showExpanded ? 'dialog' : undefined}
        aria-modal={showExpanded ? true : undefined}
        aria-label={showExpanded ? `${personName}'s desk, full screen` : undefined}
        onKeyDown={onShellKeyDown}
        style={
          showExpanded
            ? undefined
            : { aspectRatio: `${AGENT_SCREEN_WIDTH} / ${AGENT_SCREEN_HEIGHT}` }
        }
        className={cn(
          'outline-none',
          showExpanded
            ? 'fixed inset-0 z-[60] flex flex-col bg-surface'
            : cn(
                'relative w-full overflow-hidden rounded-lg border border-border bg-overlay transition-shadow',
                drivingNow && 'ring-2 ring-warning ring-offset-2 ring-offset-surface',
              ),
        )}
      >
        {showExpanded ? (
          <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface px-4">
            <span className="truncate text-sm font-medium text-fg">{personName}&apos;s desk</span>
            <span className="flex shrink-0 items-center gap-1.5">
              {statusBadge}
              {/* The way out is always visible, whatever the keyboard is doing:
                  while somebody is driving, Escape belongs to the desktop. */}
              <WorkSurfaceFullscreenButton expanded onToggle={collapse} surface="desktop" shortcut="Shift F" />
            </span>
          </header>
        ) : null}

        {/* The picture area. A positioned box in both layouts — filling the
            screen box in the pane, taking what the header and footer leave at
            full size — because the surface inside it is `absolute inset-0` and
            `framePoint` measures the picture's own rect against it. */}
        <div
          className={cn(
            'relative bg-overlay',
            showExpanded
              ? cn('min-h-0 flex-1 overflow-hidden', drivingNow && 'ring-2 ring-inset ring-warning')
              : 'absolute inset-0',
          )}
        >
          {liveScreen}
          {liveBadge}
        </div>

        {showExpanded ? (
          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border bg-bg-subtle px-4 py-3">
            <div className="min-w-0 flex-1">{notice}</div>
            {controls}
          </footer>
        ) : null}
      </div>

      {showExpanded ? null : <div className="mt-3">{notice}</div>}
      {showExpanded ? null : <div className="mt-3">{controls}</div>}
    </div>
  )

  // A pane, not a card: the surface and its border belong to the one card the
  // chat screen draws around all three columns (components/chat-workspace.tsx).
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {header}
      <div className="app-scroll min-h-0 flex-1 overflow-y-auto p-3">
        {body}
        {/* Its own slot, never shared with anything else. React matches
            children by position, so a picture that shares a slot with the
            status messages above is a picture that can be reconciled away by
            an unrelated change of status — and, being a `<video>` fed by a
            MediaSource, cannot come back from that. */}
        {screenOpen ? liveBlock : null}
        {controlError !== null ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {controlError}
          </p>
        ) : null}
      </div>
    </div>
  )
}
