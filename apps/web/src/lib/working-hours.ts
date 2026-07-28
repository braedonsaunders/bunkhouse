import 'server-only'
import type { AgentWorkingHours } from '../db/schema'

/**
 * Working hours: whether an instant falls inside an agent's working window,
 * resolved in the agent's own timezone. Null hours mean always on. Inbound
 * email work outside the window simply waits — the mailbox pass retries every
 * couple of minutes, so work starts within minutes of the window opening.
 */
export function isWithinWorkingHours(hours: AgentWorkingHours | null | undefined, at = new Date()): boolean {
  if (!hours || hours.days.length === 0) return true
  let parts: { weekday: number; minutes: number }
  try {
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: hours.timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at)
    const weekdayName = formatted.find((p) => p.type === 'weekday')?.value ?? ''
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayName)
    const hour = Number(formatted.find((p) => p.type === 'hour')?.value ?? '0') % 24
    const minute = Number(formatted.find((p) => p.type === 'minute')?.value ?? '0')
    parts = { weekday, minutes: hour * 60 + minute }
  } catch {
    // An unresolvable timezone must never silence an agent — treat as always on.
    return true
  }
  if (parts.weekday < 0 || !hours.days.includes(parts.weekday)) return false
  const toMinutes = (hhmm: string): number => {
    const [h, m] = hhmm.split(':')
    return Number(h) * 60 + Number(m ?? 0)
  }
  const start = toMinutes(hours.start)
  const end = toMinutes(hours.end)
  if (Number.isNaN(start) || Number.isNaN(end) || start === end) return true
  // Overnight windows (e.g. 22:00–06:00) wrap past midnight.
  return start < end
    ? parts.minutes >= start && parts.minutes < end
    : parts.minutes >= start || parts.minutes < end
}
