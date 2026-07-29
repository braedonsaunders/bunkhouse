'use client'

import * as React from 'react'
import { Loader2, Mic, MicOff, MonitorPlay, PauseCircle, PhoneOff } from 'lucide-react'
import { Badge, Button, Tooltip, cn } from '@appkit/ui'

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
 * What the far side is looking at, when it is working a screen rather than
 * only talking: one frame, already captured and served, plus where it came
 * from. The stage renders it; it never goes looking for it.
 */
export type CallStageScreenView = {
  /**
   * True while the far side is still at this screen. A screen that has been
   * left stays on the stage one beat longer, faded, so the face grows back
   * into an empty stage instead of out of a hole.
   */
  live: boolean
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
 * The far side's screen, on the stage: the newest captured frame with the page
 * it belongs to named above it and the current action below.
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
      {view.imageUrl ? (
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
      <div className="absolute inset-x-0 top-0 flex items-center gap-2 border-b border-border bg-surface/90 px-3 py-2 text-left backdrop-blur">
        <MonitorPlay aria-hidden className="size-4 shrink-0 text-fg-muted" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">{view.title}</p>
          {view.host ? <p className="truncate text-xs text-fg-muted">{view.host}</p> : null}
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-fg-muted">
          <span aria-hidden className="inline-block size-1.5 animate-pulse rounded-full bg-primary" />
          Live · <span className="tabular-nums">{formatCallDuration(view.atSeconds)}</span>
        </span>
      </div>
      {/* Cleared on the right for the inset face, which shares this corner. */}
      <div className="absolute inset-x-3 bottom-3 flex justify-start pr-32">
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
      </div>
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
  const scale = inset ? INSET_AVATAR_SIZE / CALL_STAGE_AVATAR_SIZE : 1
  const centred = `calc(50% - ${CALL_STAGE_AVATAR_SIZE / 2}px)`

  const statusLine =
    status ??
    (phase === 'live' ? (
      <span className="font-medium tabular-nums text-fg">{formatCallDuration(elapsedSeconds)}</span>
    ) : phase === 'ringing' ? (
      'Ringing…'
    ) : phase === 'ended' ? (
      elapsedSeconds > 0 ? (
        <>Call ended · <span className="tabular-nums">{formatCallDuration(elapsedSeconds)}</span></>
      ) : (
        'Call ended'
      )
    ) : (
      'Calling…'
    ))
  return (
    <div className="bh-call-enter flex w-full flex-col items-center gap-5 text-center">
      {/* The stage floor: a screen's shape, kept whether or not one is shown, so
          nothing below it moves when the far side picks up a keyboard. */}
      <div className="relative aspect-[64/45] min-h-80 w-full max-w-xl">
        {screen ? <CallStageScreen view={screen} name={name} activity={activity} /> : null}
        <div
          className="bh-call-avatar absolute z-10 rounded-full bg-surface"
          style={{
            width: CALL_STAGE_AVATAR_SIZE * scale,
            height: CALL_STAGE_AVATAR_SIZE * scale,
            right: inset ? INSET_MARGIN : centred,
            bottom: inset ? INSET_MARGIN : centred,
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
            className={cn(
              'bh-call-avatar-scale relative origin-top-left',
              phase === 'ended' ? 'opacity-70' : 'opacity-100',
            )}
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
      <div className="space-y-1">
        <p className="text-2xl font-semibold text-fg">{name}</p>
        <p className="text-sm text-fg-muted">{title}</p>
      </div>
      {activity && !inset ? (
        <div className="flex w-full max-w-xl justify-center">
          <CallStageActivityLine key={activity.key} activity={activity} />
        </div>
      ) : null}
      {/* Keyed by phase so each phase's line enters on the shared transition. */}
      <div key={phase} className="bh-call-enter flex min-h-6 items-center justify-center text-sm text-fg-muted">
        {statusLine}
      </div>
    </div>
  )
}

const STATUS_DOT: Record<CallStatusTone, string> = {
  ok: 'bg-success',
  pending: 'bg-warning animate-pulse',
  off: 'bg-fg-subtle',
}

/**
 * The control bar anchored under the stage: round mic and end-call controls —
 * end-call visually destructive — with the connection state surfaced as a
 * quiet dot and label, never a headline.
 */
export function CallControlBar({
  micEnabled,
  onToggleMic,
  onEnd,
  ending,
  statusLabel,
  statusTone,
}: {
  micEnabled: boolean
  onToggleMic: () => void
  onEnd: () => void
  /** Disables the controls while the hang-up is being finalized. */
  ending: boolean
  statusLabel: string
  statusTone: CallStatusTone
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center gap-4">
        <Tooltip content={micEnabled ? 'Turn microphone off' : 'Turn microphone on'}>
          <Button
            type="button"
            size="icon"
            variant={micEnabled ? 'outline' : 'secondary'}
            className="size-14 rounded-full"
            aria-label={micEnabled ? 'Turn microphone off' : 'Turn microphone on'}
            aria-pressed={!micEnabled}
            disabled={ending}
            onClick={onToggleMic}
          >
            {micEnabled ? <Mic className="size-5" /> : <MicOff className="size-5" />}
          </Button>
        </Tooltip>
        <Tooltip content="End call">
          <Button
            type="button"
            size="icon"
            variant="destructive"
            className="size-14 rounded-full"
            aria-label="End call"
            disabled={ending}
            onClick={onEnd}
          >
            <PhoneOff className="size-5" />
          </Button>
        </Tooltip>
      </div>
      <p className="flex items-center gap-1.5 text-xs text-fg-muted">
        <span aria-hidden className={cn('inline-block size-1.5 rounded-full', STATUS_DOT[statusTone])} />
        {statusLabel}
      </p>
    </div>
  )
}
