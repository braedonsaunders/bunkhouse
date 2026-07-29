'use client'

import * as React from 'react'
import { Mic, MicOff, PhoneOff } from 'lucide-react'
import { Button, Tooltip, cn } from '@appkit/ui'

/**
 * The presentational half of a voice call: the stage the far side stands on,
 * the control bar under it, and the phase/timer logic that drives both. No
 * data coupling — everything arrives as props and leaves as callbacks — so
 * these pieces can lift into a shared package unchanged. The wiring (LiveKit
 * state, call actions, the avatar renderer) lives in call-room.tsx.
 */

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
 * The centerpiece: whoever is on the other end, full face, with presence
 * effects driven by real state — a ripple only while ringing, a halo only
 * while they are actually speaking. The halo fades on the motion system's
 * default transition; the ripple is the one continuous loop the transition
 * system cannot express, so it lives in globals.css with the other
 * compositor-owned keyframes and honors reduced motion there.
 */
export function CallStage({
  name,
  title,
  phase,
  speaking,
  elapsedSeconds,
  status,
  avatar,
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
}) {
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
    <div className="bh-call-enter flex flex-col items-center gap-5 text-center">
      <div className="relative">
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
        <div className={cn('relative transition-opacity', phase === 'ended' ? 'opacity-70' : 'opacity-100')}>{avatar}</div>
      </div>
      <div className="space-y-1">
        <p className="text-2xl font-semibold text-fg">{name}</p>
        <p className="text-sm text-fg-muted">{title}</p>
      </div>
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
