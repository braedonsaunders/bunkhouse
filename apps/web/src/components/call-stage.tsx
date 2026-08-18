'use client'

import * as React from 'react'
import {
  Captions,
  CaptionsOff,
  Check,
  ChevronDown,
  Loader2,
  Mic,
  MicOff,
  MonitorPlay,
  PauseCircle,
  PhoneOff,
  ScreenShare,
} from 'lucide-react'
import {
  Badge,
  Button,
  ContextMenu,
  Tooltip,
  cn,
  useContextMenu,
  type ContextMenuEntry,
} from '@braedonsaunders/appkit-ui'
import { useElementSize } from '@braedonsaunders/appkit-scene'

/**
 * The presentational half of a voice call: the stage the far side stands on,
 * the control bar under it, and the phase/timer logic that drives both. No
 * data coupling — everything arrives as props and leaves as callbacks — so
 * these pieces can lift into a shared package unchanged. The wiring (LiveKit
 * state, call actions, the avatar renderer) lives in call-room.tsx.
 */

/** The stage avatar's rendered size — the call's centrepiece, not a thumbnail. */
export const CALL_STAGE_AVATAR_SIZE = 320
/** The size the face shrinks to once it shares the stage with a screen. */
const INSET_AVATAR_SIZE = 112
/** The inset face's distance from the screen's corner, in pixels. */
const INSET_MARGIN = 12
/**
 * The stage floor's width when nothing is squeezing it — `max-w-xl` in pixels.
 * Every pixel figure on the floor is quoted at this width and multiplied by the
 * width the floor actually got, so a stage that has been shortened to fit the
 * viewport carries a face the right size for it rather than one that spills
 * out of its own box.
 */
const STAGE_BASE_WIDTH = 576

/**
 * What the far side is looking at, when it is working a screen rather than
 * only talking, plus where it came from. The stage renders it; it never goes
 * looking for it.
 *
 * Two ways to be shown a screen, in that order of preference: as live video —
 * handed in already rendered, so this file stays free of any transport — and,
 * failing that, as the newest captured still. The still is not a lesser
 * fallback but a different thing: it is what a replayed run has, and what a
 * screen that has already been left leaves behind.
 */
export type CallStageScreenView = {
  /**
   * True while the far side is still at this screen. A screen that has been
   * left stays on the stage one beat longer, faded, so the face grows back
   * into an empty stage instead of out of a hole.
   */
  live: boolean
  /**
   * The screen as live video — a rendered node, or null when there is none.
   * Preferred over the still whenever it is present: it is the same screen,
   * moving, at the moment it moves.
   */
  video?: React.ReactNode | null
  /** The frame's URL, or null when that step's capture failed. */
  imageUrl: string | null
  /** The page: its title, or its address when the page has no title. */
  title: string
  /** The host, shown under the title when it adds something the title doesn't. */
  host: string | null
  /** What was just done on the page, in plain words — "Clicked Sign in". */
  action: string
  /** When the frame was captured, on the call clock. */
  atSeconds: number
  /** Changes with every frame, so each new caption enters on the transition. */
  frameKey: string
  /** A complete non-video work surface, such as a durable terminal. */
  content?: React.ReactNode
}

/**
 * The one thing happening right now, for the line under the face. Never a
 * list — the call's full activity belongs in the transcript beside the stage.
 */
export type CallStageActivity = {
  /** Stable per action, so the line enters once and then simply updates. */
  key: string
  /** What is being done, in plain words. */
  label: string
  /** `queued` means the action is parked until someone signs it off. */
  status: 'running' | 'queued'
  /** The action's mark, supplied by the caller — the stage knows no tool names. */
  icon?: React.ReactNode
}

/**
 * A call's four phases, in order: `dialling` while the call is being placed
 * or the room connection is coming up, `ringing` once we are in the room but
 * the far side has not joined, `live` while both sides are on, and `ended`
 * when the room has closed — by either side hanging up. Ending is a normal
 * phase, never an error.
 */
export type CallPhase = 'dialling' | 'ringing' | 'live' | 'ended'

/** The quiet connection dot's tone: healthy, in flux, or gone. */
export type CallStatusTone = 'ok' | 'pending' | 'off'

/** mm:ss for the live call clock; minutes keep counting past the hour. */
export function formatCallDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * Elapsed seconds of the live call. The clock starts the first time `live`
 * goes true and freezes at its last value when it goes false again — which is
 * exactly the duration to show on the ended stage. A reconnect wobble does
 * not restart it: the start mark is kept across pauses.
 */
export function useCallTimer(live: boolean): number {
  const [elapsed, setElapsed] = React.useState(0)
  const startRef = React.useRef<number | null>(null)
  React.useEffect(() => {
    if (!live) return
    if (startRef.current === null) startRef.current = Date.now()
    const start = startRef.current
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000))
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [live])
  return elapsed
}

/**
 * The line under the face: what the far side is doing this second. Running
 * work spins quietly; work parked for a signature says so plainly, because a
 * caller who is not told will keep waiting for something that cannot happen.
 * Callers key it by the action so each new one enters on the shared
 * transition rather than swapping its words in place.
 */
function CallStageActivityLine({ activity }: { activity: CallStageActivity }) {
  const queued = activity.status === 'queued'
  return (
    <div
      aria-live="polite"
      className={cn(
        'bh-call-enter flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-left text-xs shadow-sm backdrop-blur',
        queued ? 'border-warning/40 bg-warning-subtle/90' : 'border-border bg-surface/90',
      )}
    >
      {queued ? (
        <PauseCircle aria-hidden className="size-4 shrink-0 text-warning" />
      ) : (
        <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-fg-muted" />
      )}
      {activity.icon ? (
        <span aria-hidden className="flex shrink-0 items-center text-fg-muted">
          {activity.icon}
        </span>
      ) : null}
      <span className="truncate font-medium text-fg">{activity.label}</span>
      {queued ? (
        <Badge variant="warning" className="shrink-0">
          Waiting for approval
        </Badge>
      ) : null}
    </div>
  )
}

/**
 * The far side's screen, on the stage: the live picture of it — moving where
 * there is video for it, the newest captured frame where there is not — with
 * the page it belongs to named above it and the current action below.
 */
function CallStageScreen({
  view,
  name,
  activity,
}: {
  view: CallStageScreenView
  name: string
  activity: CallStageActivity | null
}) {
  return (
    <div
      aria-hidden={!view.live}
      className={cn(
        'bh-call-enter absolute inset-0 overflow-hidden rounded-xl border border-border bg-bg-subtle shadow-md transition-opacity',
        view.live ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      {view.content ? (
        <div className="size-full">{view.content}</div>
      ) : view.video ? (
        // The screen itself, moving. Handed in whole rather than built here:
        // whatever is carrying it — a media track today — is the caller's
        // business, not the stage's.
        <div className="size-full [&>video]:size-full [&>video]:object-cover [&>video]:object-top">
          {view.video}
        </div>
      ) : view.imageUrl ? (
        // A plain <img>: the frame is served straight from the files ledger at
        // the size it was captured, there is nothing to optimize, and this
        // component carries no framework beyond React by design. Swapping the
        // src in place — rather than keying a new element — lets the browser
        // hold the last frame until the next one has decoded, so a live screen
        // never blinks white between steps.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={view.imageUrl}
          alt={`${name}'s browser, showing ${view.title}`}
          className="size-full object-cover object-top"
        />
      ) : (
        <p className="flex size-full items-center justify-center px-8 text-sm text-fg-muted">
          This step could not be captured. It is still on the call record.
        </p>
      )}
      {view.content ? null : <div className="absolute inset-x-0 top-0 flex items-center gap-2 border-b border-border bg-surface/90 px-3 py-2 text-left backdrop-blur">
        <MonitorPlay aria-hidden className="size-4 shrink-0 text-fg-muted" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">{view.title}</p>
          {view.host ? <p className="truncate text-xs text-fg-muted">{view.host}</p> : null}
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-fg-muted">
          <span aria-hidden className="inline-block size-1.5 animate-pulse rounded-full bg-primary" />
          Live · <span className="tabular-nums">{formatCallDuration(view.atSeconds)}</span>
        </span>
      </div>}
      {/* Cleared on the right for the inset face, which shares this corner. */}
      {view.content ? null : <div className="absolute inset-x-3 bottom-3 flex justify-start pr-32">
        {activity ? (
          <CallStageActivityLine key={activity.key} activity={activity} />
        ) : (
          <p
            key={view.frameKey}
            className="bh-call-enter max-w-full truncate rounded-full border border-border bg-surface/90 px-3 py-1.5 text-xs text-fg-muted shadow-sm backdrop-blur"
          >
            {view.action}
          </p>
        )}
      </div>}
    </div>
  )
}

/**
 * The centerpiece: whoever is on the other end, full face, with presence
 * effects driven by real state — a ripple only while ringing, a halo only
 * while they are actually speaking. The halo fades on the motion system's
 * default transition; the ripple is the one continuous loop the transition
 * system cannot express, so it lives in globals.css with the other
 * compositor-owned keyframes and honors reduced motion there.
 *
 * When the far side is working a screen, that screen takes the stage and the
 * face shrinks into its corner — still present, still speaking, no longer the
 * whole picture. The face is one element in one place throughout: it moves and
 * scales on the motion system rather than being re-mounted somewhere else, so
 * the avatar's own animation never restarts mid-call.
 *
 * The stage fills the height it is handed and never asks for more: the floor
 * holds a screen's shape and shrinks inside it when the viewport is short, and
 * the face — which is painted at a pixel size, not a CSS one — is scaled to
 * whatever width the floor ended up with.
 *
 * The ending is the same movement run out: on `ended` the face settles back
 * and fades where it stands — the far side stepping away from the phone — and
 * the line under it resolves to who was called, that the call ended, and how
 * long it lasted, frozen. Nothing vanishes and nothing is left spinning.
 */
export function CallStage({
  name,
  title,
  phase,
  speaking,
  elapsedSeconds,
  status,
  avatar,
  screen = null,
  activity = null,
}: {
  name: string
  title: string
  phase: CallPhase
  /** True only while the far side is audibly speaking — never mere presence. */
  speaking: boolean
  elapsedSeconds: number
  /** Overrides the phase-derived status line (e.g. an error headline). */
  status?: React.ReactNode
  avatar: React.ReactNode
  /** The screen the far side is working — `live: false` once it has left it. */
  screen?: CallStageScreenView | null
  /** The one action in flight right now, if there is one. */
  activity?: CallStageActivity | null
}) {
  const inset = screen?.live === true
  const ended = phase === 'ended'

  // The floor is measured because the face cannot be sized in CSS: the avatar
  // renderer paints its layers at a pixel size, so a stage that has been given
  // less room than its full width has to hand that ratio to the face itself.
  // Until the first measurement lands the floor is assumed to be at full width,
  // which is what it is on any desktop tall enough not to squeeze it — and the
  // correction rides the same transition as every other move the face makes.
  const [floorRef, floor] = useElementSize<HTMLDivElement>()
  const stageScale = floor.width > 0 ? Math.min(1, floor.width / STAGE_BASE_WIDTH) : 1
  const faceSize = (inset ? INSET_AVATAR_SIZE : CALL_STAGE_AVATAR_SIZE) * stageScale
  const scale = faceSize / CALL_STAGE_AVATAR_SIZE
  const centred = `calc(50% - ${faceSize / 2}px)`
  const insetMargin = INSET_MARGIN * stageScale

  const statusLine =
    status ??
    (phase === 'live' ? (
      <span className="font-medium tabular-nums text-fg">{formatCallDuration(elapsedSeconds)}</span>
    ) : phase === 'ringing' ? (
      'Ringing…'
    ) : ended ? (
      // The one line that has to survive the caller looking away and back:
      // the call is over, and this is what it came to. A call that ended
      // before anyone picked up has no duration to show, and says so by
      // showing none.
      <span className="flex items-center gap-2">
        <PhoneOff aria-hidden className="size-4 shrink-0" />
        <span className="font-medium text-fg">Call ended</span>
        {elapsedSeconds > 0 ? (
          <span className="tabular-nums">{formatCallDuration(elapsedSeconds)}</span>
        ) : null}
      </span>
    ) : (
      'Calling…'
    ))
  return (
    <div className="bh-call-enter flex min-h-0 w-full flex-1 flex-col items-center gap-5 text-center">
      {/* The room the floor stands in. From `lg` up it is a size container, and
          it is what turns a height the page has already fixed into a width the
          floor can use: the floor may be as wide as the column allows, but
          never wider than its own height can carry at the screen's shape. That
          is the whole trick to a call that fits the viewport — the stage gives
          way, and the control bar under it never moves out of reach.

          Below `lg` the columns stack and the screen scrolls, so there is no
          height to divide up: containment is off and the floor is sized by its
          width exactly as it always was. */}
      <div className="flex min-h-0 w-full flex-1 items-center justify-center lg:[container-type:size]">
        {/* The stage floor: a screen's shape, kept whether or not one is shown,
            so nothing below it moves when the far side picks up a keyboard. */}
        <div
          ref={floorRef}
          // The floor keeps a little height of its own even on a screen with
          // nothing to spare: a floor of exactly nothing is indistinguishable
          // from one that has not been measured yet, and the face would be
          // drawn at full size on top of the controls.
          className="relative aspect-[64/45] min-h-80 w-full max-w-xl lg:min-h-16 lg:max-w-[min(36rem,calc(100cqh*64/45))]"
        >
          {screen ? <CallStageScreen view={screen} name={name} activity={activity} /> : null}
          <div
            className={cn(
              'bh-call-avatar absolute z-10 rounded-full bg-surface',
              // The settle-out, on the same transition that carries the face
              // between its two homes: it steps back and dims where it stands,
              // about its own centre, and stops there.
              ended && 'scale-90 opacity-40',
            )}
            style={{
              width: faceSize,
              height: faceSize,
              right: inset ? insetMargin : centred,
              bottom: inset ? insetMargin : centred,
            }}
          >
            {phase === 'ringing' ? (
              <span aria-hidden className="bh-call-ripple pointer-events-none absolute -inset-1.5 rounded-full border-2 border-primary/50" />
            ) : null}
            <span
              aria-hidden
              className={cn(
                'pointer-events-none absolute -inset-5 rounded-full bg-primary/25 blur-2xl transition-opacity',
                speaking ? 'opacity-100' : 'opacity-0',
              )}
            />
            <span
              aria-hidden
              className={cn(
                'pointer-events-none absolute -inset-1.5 rounded-full border-2 border-primary/60 transition-opacity',
                speaking ? 'opacity-100' : 'opacity-0',
              )}
            />
            <div
              className="bh-call-avatar-scale relative origin-top-left"
              style={{
                width: CALL_STAGE_AVATAR_SIZE,
                height: CALL_STAGE_AVATAR_SIZE,
                transform: `scale(${scale})`,
              }}
            >
              {avatar}
            </div>
          </div>
        </div>
      </div>
      {/* Everything under the floor keeps its full height whatever the viewport
          does — the floor above is the one thing that gives way. */}
      <div className="shrink-0 space-y-1">
        <p className="text-2xl font-semibold text-fg">{name}</p>
        <p className="text-sm text-fg-muted">{title}</p>
      </div>
      {activity && !inset ? (
        <div className="flex w-full max-w-xl shrink-0 justify-center">
          <CallStageActivityLine key={activity.key} activity={activity} />
        </div>
      ) : null}
      {/* Keyed by phase so each phase's line enters on the shared transition. */}
      <div key={phase} className="bh-call-enter flex min-h-6 shrink-0 items-center justify-center text-sm text-fg-muted">
        {statusLine}
      </div>
      {/* The ending, said out loud. Mounted for the whole call and empty until
          there is one, because a live region that arrives with its content is
          announced unreliably — and because the live call's own line is a
          clock, which no one should have read to them every second. The
          control that was just pressed is on its way out, so this is all a
          caller who is not watching the screen has to go on. */}
      <div aria-live="polite" className="sr-only">
        {ended
          ? elapsedSeconds > 0
            ? `Call with ${name} ended after ${formatCallDuration(elapsedSeconds)}.`
            : `Call with ${name} ended.`
          : ''}
      </div>
    </div>
  )
}

const STATUS_DOT: Record<CallStatusTone, string> = {
  ok: 'bg-success',
  pending: 'bg-warning animate-pulse',
  off: 'bg-fg-subtle',
}

/** An audio input the caller can pick, already labelled for a human to read. */
export type CallDeviceOption = {
  /** The browser's device id — what `onSelectMicDevice` is handed back. */
  deviceId: string
  /** The device's name, e.g. "MacBook Pro Microphone". Never blank. */
  label: string
}

/**
 * The control bar anchored under the stage: round mic, screen-share, transcript
 * and end-call controls — end-call visually destructive — with the connection
 * state surfaced as a quiet dot and label, never a headline.
 *
 * Once the call is over the bar retires: it settles back and fades on the
 * stage's shared transition, keeping its space so nothing under it jumps, and
 * goes inert — out of the tab order and out of the accessibility tree in one
 * move, which is the only honest way to hide something that still has focus in
 * it. It is never removed mid-fade; the ending is what removes it.
 *
 * Every control is a toggle whose state the caller can read without colour: the
 * icon changes with the state, `aria-pressed` carries it to assistive tech, and
 * a control that cannot be used right now stays in place, disabled, with the
 * reason in its tooltip and its accessible name rather than disappearing.
 *
 * Nothing here reaches for state of its own — the mic, the share, and the
 * device list are all held above and arrive as props, so the bar can be lifted
 * out whole.
 */
export function CallControlBar({
  micEnabled,
  onToggleMic,
  micDevices,
  activeMicDeviceId,
  onSelectMicDevice,
  sharingScreen,
  sharePending,
  onToggleScreenShare,
  shareUnavailableReason = null,
  screenWatchedBy = null,
  transcriptVisible,
  onToggleTranscript,
  onEnd,
  ended,
  statusLabel,
  statusTone,
}: {
  micEnabled: boolean
  onToggleMic: () => void
  /** The inputs to offer. Empty hides the picker — a menu of nothing is worse. */
  micDevices: CallDeviceOption[]
  /** The input currently carrying the call, ticked in the menu. */
  activeMicDeviceId: string
  onSelectMicDevice: (deviceId: string) => void
  /** True while the caller's screen is actually being sent, never optimistic. */
  sharingScreen: boolean
  /** True between the click and the browser settling the share either way. */
  sharePending: boolean
  onToggleScreenShare: () => void
  /** Why sharing cannot be started right now, in plain words, or null. */
  shareUnavailableReason?: string | null
  /** Who is watching the shared screen, when we actually know. Off by default. */
  screenWatchedBy?: string | null
  /** Whether the transcript panel beside the stage is shown. */
  transcriptVisible: boolean
  onToggleTranscript: () => void
  onEnd: () => void
  /** The call is over: the bar retires and its controls stop responding. */
  ended: boolean
  statusLabel: string
  statusTone: CallStatusTone
}) {
  const micMenu = useContextMenu()
  const micItems: ContextMenuEntry[] = micDevices.map((device) => ({
    key: device.deviceId,
    label: device.label,
    // A tick on the one in use, a mic on the rest: the state reads in grayscale
    // and every row keeps the same left edge.
    icon: device.deviceId === activeMicDeviceId ? Check : Mic,
    onSelect: () => onSelectMicDevice(device.deviceId),
  }))

  const micLabel = micEnabled ? 'Turn microphone off' : 'Turn microphone on'
  const shareLabel = sharingScreen ? 'Stop sharing your screen' : 'Share your screen'
  const shareBlocked = shareUnavailableReason !== null
  const transcriptLabel = transcriptVisible ? 'Hide transcript' : 'Show transcript'

  return (
    <div
      inert={ended}
      className={cn(
        // Never shrinks: on a screen too short for everything, the stage above
        // gives way and the bar stays whole. Reaching it is the point.
        'bh-call-enter flex w-full shrink-0 flex-col items-center gap-3',
        ended && 'scale-95 opacity-0',
      )}
    >
      {/* Four round controls fit a 320px screen at the tighter gap; the wrap is
          the safety net for anything narrower still. */}
      <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-4">
        <div className="relative inline-flex">
          <Tooltip content={micLabel}>
            <Button
              type="button"
              size="icon"
              variant={micEnabled ? 'outline' : 'secondary'}
              className="size-14 rounded-full"
              aria-label={micLabel}
              aria-pressed={!micEnabled}
              disabled={ended}
              onClick={onToggleMic}
            >
              {micEnabled ? <Mic className="size-5" /> : <MicOff className="size-5" />}
            </Button>
          </Tooltip>
          {micDevices.length > 0 ? (
            <span className="absolute -right-1 -top-1 z-10">
              <Tooltip content="Choose microphone">
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  className="size-7 rounded-full border border-border shadow-sm"
                  aria-label="Choose microphone"
                  aria-haspopup="menu"
                  aria-expanded={micMenu.open}
                  disabled={ended}
                  onClick={(event: React.MouseEvent<HTMLButtonElement>) => micMenu.openBelow(event.currentTarget)}
                >
                  <ChevronDown className="size-3.5" />
                </Button>
              </Tooltip>
            </span>
          ) : null}
        </div>
        <Tooltip content={shareUnavailableReason ?? shareLabel}>
          <Button
            type="button"
            size="icon"
            variant={sharingScreen ? 'default' : 'outline'}
            className="size-14 rounded-full"
            // A disabled control cannot take focus, so its reason has to travel
            // in the name itself — the tooltip alone would never be heard.
            aria-label={shareBlocked ? `${shareLabel} — ${shareUnavailableReason}` : shareLabel}
            aria-pressed={sharingScreen}
            disabled={ended || sharePending || shareBlocked}
            onClick={onToggleScreenShare}
          >
            {sharePending ? (
              <Loader2 aria-hidden className="size-5 animate-spin" />
            ) : (
              <ScreenShare className="size-5" />
            )}
          </Button>
        </Tooltip>
        <Tooltip content={transcriptLabel}>
          <Button
            type="button"
            size="icon"
            variant={transcriptVisible ? 'outline' : 'secondary'}
            className="size-14 rounded-full"
            aria-label={transcriptLabel}
            aria-pressed={transcriptVisible}
            onClick={onToggleTranscript}
          >
            {transcriptVisible ? <Captions className="size-5" /> : <CaptionsOff className="size-5" />}
          </Button>
        </Tooltip>
        <Tooltip content="End call">
          <Button
            type="button"
            size="icon"
            variant="destructive"
            className="size-14 rounded-full"
            aria-label="End call"
            disabled={ended}
            onClick={onEnd}
          >
            <PhoneOff className="size-5" />
          </Button>
        </Tooltip>
      </div>
      {/* The share is the one thing a caller must never have to wonder about,
          so while it is on it says so in words, in its own right, with the way
          out attached. The region itself is mounted for the whole call, empty
          until there is something to say: a live region that arrives at the
          same moment as its content is announced unreliably. */}
      <div aria-live="polite" className="flex max-w-full justify-center">
        {sharingScreen ? (
          <div className="bh-call-enter flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-full border border-primary/40 bg-primary-subtle px-3 py-1.5 text-xs font-medium text-primary">
            <span aria-hidden className="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
            <span className="truncate">
              {screenWatchedBy
                ? `${screenWatchedBy} is watching your screen`
                : 'You are sharing your screen'}
            </span>
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 text-xs font-semibold"
              disabled={ended || sharePending}
              onClick={onToggleScreenShare}
            >
              Stop sharing
            </Button>
          </div>
        ) : null}
      </div>
      <p className="flex items-center gap-1.5 text-xs text-fg-muted">
        <span aria-hidden className={cn('inline-block size-1.5 rounded-full', STATUS_DOT[statusTone])} />
        {statusLabel}
      </p>
      {/* The menu goes with the bar: a floating list of microphones outlives
          nothing, least of all the call it belonged to. */}
      <ContextMenu open={micMenu.open && !ended} position={micMenu.position} items={micItems} onClose={micMenu.close} />
    </div>
  )
}
