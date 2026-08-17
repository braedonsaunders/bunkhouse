'use client'

import * as React from 'react'
import Link from 'next/link'
import { EyeOff, Loader2, Maximize2, Minimize2, Monitor, MonitorOff, MousePointer2, ShieldAlert } from 'lucide-react'
import { Badge, Button, Drawer, EmptyState, cn } from '@appkit/ui'
import { AGENT_SCREEN_HEIGHT, AGENT_SCREEN_WIDTH } from '../lib/agent-screen'
import {
  closeDesktopAction,
  deskStatusAction,
  openDesktopAction,
  sendDesktopInputAction,
  setDeskFrameRateAction,
  takeoverAction,
} from '../app/chat/actions'

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
 * picture in two frames rather than two views: the frame stream, the status
 * poll, the driving mode and the typing buffer all live here and are untouched
 * by the move, the input surface is a single element that is re-parented into
 * the overlay, and the coordinate translation is the one `framePoint` reading
 * the live box — so a click lands on the same pixel at either size.
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
 * While someone is driving, every Escape belongs to the desktop, so the
 * overlay declares that with `data-ui-overlay` and the surface never gets
 * closed out from under a task. That attribute is read by the overlay when the
 * key is pressed, and React has already re-rendered by then if the press was
 * the second of the pair that stops driving — the attribute is gone, and the
 * same keystroke that handed control back would also collapse the view. This
 * window is what makes the two separate acts: stop driving, then leave.
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
 * The image is laid out `object-contain`, so:
 *
 *   scale   = min(boxWidth / frameWidth, boxHeight / frameHeight)
 *   drawnW  = frameWidth * scale,  drawnH = frameHeight * scale
 *   originX = (boxWidth - drawnW) / 2,  originY = (boxHeight - drawnH) / 2
 *   frameX  = (clientX - boxLeft - originX) / scale
 *   frameY  = (clientY - boxTop  - originY) / scale
 *
 * The frame's size is read from the decoded image (`naturalWidth`), not from
 * what the stream said it would be: the decoded picture is the thing the
 * coordinates are quoted against, and the two disagree the moment a
 * compositor hands back something other than the size it was asked for.
 *
 * Because every term comes from the element's live box, the pane and the
 * full-screen view need one function between them rather than one each: the
 * picture is four times the size in the overlay and the scale simply comes out
 * four times larger. A second copy of this sum, drifting from the first, would
 * show up as clicks that land near the target — which reads as a broken desk.
 *
 * A point in the letterbox belongs to no pixel of the frame, so it returns
 * null and nothing is sent.
 */
function framePoint(image: HTMLImageElement, clientX: number, clientY: number): { x: number; y: number } | null {
  const frameWidth = image.naturalWidth
  const frameHeight = image.naturalHeight
  if (frameWidth === 0 || frameHeight === 0) return null
  const box = image.getBoundingClientRect()
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
 * The live picture of the desk.
 *
 * Server-sent events are the preferred transport — the runner already pushes
 * frames that way and a still screen costs nothing on it. A deployment whose
 * frame stream is not answering (an older route, a proxy that will not carry
 * SSE) falls back to polling the single-frame endpoint, so the pane shows the
 * desk either way. The fallback is chosen on the stream's first failure with
 * nothing yet delivered: a stream that has been working and then drops is a
 * reconnect, which EventSource does by itself.
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
  /** Whether the desk is filling the window rather than sitting in its pane. */
  const [expanded, setExpanded] = React.useState(false)
  /**
   * Whether the full-screen view is on screen at all — which includes the
   * moment it is sliding out. `expanded` is the intent; this is the presence,
   * and the two differ for the length of the exit. That difference is what
   * keeps the pane from drawing a second picture while the overlay is still
   * holding the only one: there is one input surface and one image ref, and
   * two of them alive at once would leave both pointing at a dead element.
   */
  const [overlayPresent, setOverlayPresent] = React.useState(false)

  // The input surface is held as state rather than in a ref because it is the
  // same element in two places: expanding re-parents it into the overlay, and
  // the native wheel listener has to follow it there. A ref would be read once
  // and left bound to an element that is no longer on screen.
  const [surface, setSurface] = React.useState<HTMLDivElement | null>(null)
  const imageRef = React.useRef<HTMLImageElement>(null)

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
  // The one subscription for both views, deliberately: it is asked for here,
  // above the pane and the full-screen overlay alike, so expanding cannot tear
  // it down and re-establish it. A re-subscribe restarts the guest's capture
  // pump, and the picture goes black at the exact moment somebody has made it
  // big enough to work in.
  const { frame, live } = useDeskFrames(personId, screenOpen && !handover.active)

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

  // Focus is what makes the keyboard live, so it is taken for the person
  // rather than left as a step they have to guess at — both when they take the
  // controls and after the surface has moved between the pane and the overlay,
  // which the overlay would otherwise end by focusing its own close button.
  React.useEffect(() => {
    if (!drivingNow || !surface) return
    // On a beat, so the overlay's own opening focus — set on the same commit —
    // has already happened and this is the one that stands.
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
  // nothing left to fill a window with, and an overlay over a closed desktop
  // is a wall in front of the conversation. Derived from the screen rather
  // than corrected after the fact — the same reason `drivingNow` is.
  const showExpanded = expanded && screenOpen

  /** The moment an Escape was handed to the guest — see GUEST_ESCAPE_GRACE_MS. */
  const guestEscapeAtRef = React.useRef(0)

  // Presence and intent are raised in the same act, so the pane hands the
  // picture over and the overlay takes it on one commit rather than either
  // rendering it twice or neither rendering it at all.
  const expand = React.useCallback(() => {
    setOverlayPresent(true)
    setExpanded(true)
  }, [])

  const collapse = React.useCallback(() => {
    // Driving is not stopped on the way out: the pane drives too, and yanking
    // the controls away because a view got smaller would lose whatever was
    // half-done. What is refused is the Escape that belonged to the desktop.
    if (Date.now() - guestEscapeAtRef.current < GUEST_ESCAPE_GRACE_MS) return
    setExpanded(false)
    // Presence is normally given up when the exit animation reports itself
    // finished. With nothing on screen to animate there is no such moment, and
    // a pane still pointing at a view that is not there would have no picture
    // in it at all.
    if (!showExpanded) setOverlayPresent(false)
  }, [showExpanded])

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

  const toggleDriving = () => {
    if (driving) {
      stopDriving()
      return
    }
    setControlError(null)
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
    // Bound to the surface element itself rather than to a ref read once: the
    // same surface is re-parented when the desk goes full screen, and this has
    // to follow it there.
    if (!surface || !drivingNow) return
    const element = surface
    const state = scrollRef.current
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const image = imageRef.current
      if (!image) return
      const point = framePoint(image, event.clientX, event.clientY)
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
  }, [drivingNow, sendInput, surface])

  const pressRef = React.useRef<{ x: number; y: number; button: 'left' | 'middle' | 'right' } | null>(null)
  const escapeRef = React.useRef(0)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drivingNow) return
    const image = imageRef.current
    if (!image) return
    const point = framePoint(image, event.clientX, event.clientY)
    if (!point) return
    event.preventDefault()
    surface?.focus()
    pressRef.current = { ...point, button: MOUSE_BUTTONS[event.button] ?? 'left' }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const press = pressRef.current
    pressRef.current = null
    if (!drivingNow || !press) return
    const image = imageRef.current
    if (!image) return
    event.preventDefault()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    // Anything typed so far belongs before the pointer lands, or it arrives in
    // whatever the click focused instead.
    flushTyping()
    const point = framePoint(image, event.clientX, event.clientY)
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
      // read as "close the full-screen view" by the overlay this surface may
      // be sitting in — the stamp is what `collapse` refuses on.
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
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-pressed={showExpanded}
            title={showExpanded ? 'Leave full screen (Shift F)' : 'Full screen (Shift F)'}
            onClick={showExpanded ? collapse : expand}
          >
            {showExpanded ? (
              <Minimize2 aria-hidden className="size-4" />
            ) : (
              <Maximize2 aria-hidden className="size-4" />
            )}
            <span className="sr-only">
              {showExpanded
                ? `Return ${personName}'s desktop to this pane (Shift F)`
                : `Fill the window with ${personName}'s desktop (Shift F)`}
            </span>
          </Button>
        ) : null}
      </span>
    </header>
  )

  /**
   * The picture and the input target, as one element rendered in one place at
   * a time — the pane's screen box, or the full-screen overlay.
   *
   * It is written once rather than twice on purpose: the refs, the handlers
   * and the classes are the same at either size, so there is one input
   * surface, one `framePoint` reading its live box, and no second <img>
   * quietly competing for the image ref.
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
      // Escape. This is the attribute appkit's overlays read to know that
      // something in front of them has claimed the key, and it is what stops
      // the release chord's first Escape from closing the view instead of
      // reaching the guest. The stamp in `collapse` covers the second one.
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
      ) : frame ? (
        // A plain <img>: the frame arrives as a data URL and there is nothing
        // for an image optimizer to do with one. The src is swapped in place
        // rather than the element being keyed, so the browser holds the last
        // frame until the next has decoded and a live screen never blinks
        // white between them. `object-contain` is what keeps the desk's own
        // shape at any size — the letterbox is the backdrop behind it, and
        // `framePoint` knows a click that lands there belongs to no pixel.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={imageRef}
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

  /** Whether the picture on screen is current, said over the picture itself. */
  const liveBadge = handover.active ? null : (
    <span className="pointer-events-none absolute right-2 top-2 flex items-center gap-1.5 rounded-full border border-border bg-surface/90 px-2 py-1 text-xs font-medium text-fg-muted backdrop-blur">
      <span
        aria-hidden
        className={cn('inline-block size-1.5 rounded-full', live ? 'animate-pulse bg-primary' : 'bg-fg-subtle')}
      />
      {live ? 'Live' : 'Waiting for a repaint'}
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
  } else if (overlayPresent) {
    // The one picture is in the full-screen view, so the pane says where it
    // went instead of drawing a second copy of a screen there is only one of.
    body = (
      <div className="space-y-4">
        <DeskScreenBox className="border-dashed bg-bg-subtle">
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center">
            <Maximize2 aria-hidden className="size-6 text-fg-subtle" />
            <p className="text-sm text-fg-muted">
              {personName}&apos;s desktop is filling the window. Nothing has been closed — the screen, the controls and
              the record are all in there.
            </p>
          </div>
        </DeskScreenBox>
        <Button type="button" variant="outline" onClick={collapse}>
          <Minimize2 aria-hidden className="size-4" />
          Bring the desk back to this pane
        </Button>
      </div>
    )
  } else {
    body = (
      <div className="space-y-3">
        <DeskScreenBox
          className={cn(
            'transition-shadow',
            drivingNow && 'ring-2 ring-warning ring-offset-2 ring-offset-surface',
          )}
        >
          {liveScreen}
          {liveBadge}
        </DeskScreenBox>
        {notice}
        {controls}
      </div>
    )
  }

  // A pane, not a card: the surface and its border belong to the one card the
  // chat screen draws around all three columns (components/chat-workspace.tsx).
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {header}
      <div className="app-scroll min-h-0 flex-1 overflow-y-auto p-3">
        {body}
        {controlError !== null ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {controlError}
          </p>
        ) : null}
      </div>

      {/* The same desk, given the window. A Drawer at full size is this app's
          full-bleed surface — portalled, modal, focus-trapped, scroll-locked
          and Escape-aware — so the full-screen desk is that rather than a
          hand-rolled layer with a z-index nobody can account for. The body
          takes the whole panel below the header, on the same dark backdrop the
          pane's screen box uses, so the letterbox around a desk of a different
          shape reads as the edge of the screen rather than as a rendering
          fault. The close control is the panel's own, and it is never
          suppressed: the way out is always visible. */}
      <Drawer
        open={showExpanded}
        onClose={collapse}
        onExitComplete={() => setOverlayPresent(false)}
        size="full"
        disableFullscreen
        title={`${personName}'s desk`}
        description="The same screen, the same controls, and the same record — with room to work in."
        headerActions={statusBadge}
        // Positioned and unpadded, so the surface can be the whole of it: the
        // picture is measured against this box by `framePoint`, and a scrollbar
        // or a stray inch of padding would be measured with it.
        bodyClassName={cn(
          'relative overflow-hidden bg-overlay',
          drivingNow && 'ring-2 ring-inset ring-warning',
        )}
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">{notice}</div>
            {controls}
          </div>
        }
      >
        {liveScreen}
        {liveBadge}
      </Drawer>
    </div>
  )
}
