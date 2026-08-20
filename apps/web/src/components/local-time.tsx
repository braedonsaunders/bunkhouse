'use client'

/**
 * A stored instant, shown in the zone of the person reading it.
 *
 * Server components render on the server, and the server is in UTC. Every
 * surface that formatted a Date with `toISOString().slice(...)` was therefore
 * printing UTC in a shape that reads exactly like local time — "2026-08-20
 * 12:00" beside a duty that everybody knows fires at 08:00. There is no marker
 * saying which zone it is, so it does not look broken; it looks like the duty
 * ran at the wrong time, which is a far more expensive thing to believe.
 *
 * The zone is only knowable on the client, so the mismatch is declared rather
 * than fought: the server emits its best effort, `suppressHydrationWarning`
 * accepts that the client will disagree, and the client's render is the one
 * that stands. That is the same trade chat-workspace has been making; this is
 * it made reusable.
 *
 * Times are ISO strings on the wire — never Date objects — so nothing can be
 * re-parsed into a different zone on the way across.
 */

export type LocalTimeFormat = 'datetime' | 'date' | 'time'

const FORMATS: Record<LocalTimeFormat, Intl.DateTimeFormatOptions> = {
  datetime: { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  date: { year: 'numeric', month: 'short', day: 'numeric' },
  time: { hour: '2-digit', minute: '2-digit' },
}

/** The label alone, for a caller that needs a string rather than an element. */
export function localTimeLabel(value: string | null | undefined, format: LocalTimeFormat = 'datetime'): string {
  if (!value) return ''
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleString(undefined, FORMATS[format])
}

export function LocalTime({
  at,
  format = 'datetime',
  fallback = '—',
}: {
  /** An ISO 8601 instant. */
  at: string | null | undefined
  format?: LocalTimeFormat
  /** Shown when there is no instant to show. */
  fallback?: string
}) {
  const label = localTimeLabel(at, format)
  if (!label) return <>{fallback}</>
  // `title` carries the full instant, so an operator comparing against a log
  // in another zone can hover rather than guess.
  return (
    <span suppressHydrationWarning title={at ?? undefined}>
      {label}
    </span>
  )
}
