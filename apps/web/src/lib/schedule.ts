import cronstrue from 'cronstrue'

/**
 * Recurring schedules are stored as cron internally but NEVER shown as cron to
 * operators: display goes through scheduleToHuman, editing goes through the
 * structured builder (ScheduleSpec ⇄ cron). Advanced cron entry exists only
 * behind the builder's Advanced toggle. One-time schedules skip cron entirely
 * and store an absolute instant.
 */
export function cronToHuman(cron: string): string {
  try {
    return cronstrue.toString(cron, { use24HourTimeFormat: false, verbose: false })
  } catch {
    return cron
  }
}

export type ScheduleSpec =
  | { mode: 'once'; at: string }
  | { mode: 'weekdays'; hour: number; minute: number }
  | { mode: 'daily'; hour: number; minute: number }
  | { mode: 'weekly'; days: number[]; hour: number; minute: number }
  | { mode: 'monthly'; day: number; hour: number; minute: number }
  | { mode: 'custom'; cron: string }

/** What the duties table stores: the kind, and the pattern or instant it means. */
export type DutySchedule = { kind: 'cron' | 'once'; schedule: string }

/**
 * A one-time schedule is authored as wall-clock time in the operator's own
 * browser zone and stored as an absolute instant, so it means the same moment
 * however the worker is configured. Recurring schedules stay cron + a named
 * timezone, since "9am every Monday" has to follow daylight saving.
 */
export function specToSchedule(spec: ScheduleSpec): DutySchedule {
  if (spec.mode === 'once') {
    const at = new Date(spec.at)
    if (Number.isNaN(at.getTime())) throw new Error('Pick a date and time for this duty.')
    return { kind: 'once', schedule: at.toISOString() }
  }
  return { kind: 'cron', schedule: specToCron(spec) }
}

export function scheduleToSpec({ kind, schedule }: DutySchedule): ScheduleSpec {
  if (kind === 'once') {
    const at = new Date(schedule)
    return { mode: 'once', at: Number.isNaN(at.getTime()) ? '' : toLocalInput(at) }
  }
  return cronToSpec(schedule)
}

/** `datetime-local` wants wall-clock in the viewer's zone, not an ISO instant. */
export function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Operator-facing schedule text for either kind. */
export function scheduleToHuman({ kind, schedule }: DutySchedule, timezone?: string | null): string {
  if (kind !== 'once') return cronToHuman(schedule)
  const at = new Date(schedule)
  if (Number.isNaN(at.getTime())) return schedule
  return `Once on ${new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(at)}`
}

export function specToCron(spec: ScheduleSpec): string {
  switch (spec.mode) {
    case 'once':
      throw new Error('A one-time schedule has no cron form.')
    case 'weekdays':
      return `${spec.minute} ${spec.hour} * * 1-5`
    case 'daily':
      return `${spec.minute} ${spec.hour} * * *`
    case 'weekly':
      return `${spec.minute} ${spec.hour} * * ${[...spec.days].sort((a, b) => a - b).join(',') || '1'}`
    case 'monthly':
      return `${spec.minute} ${spec.hour} ${spec.day} * *`
    case 'custom':
      return spec.cron.trim()
  }
}

/** Best-effort parse of the crons the builder writes; anything else → custom. */
export function cronToSpec(cron: string): ScheduleSpec {
  const parts = cron.trim().split(/\s+/)
  if (parts.length === 5) {
    const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string]
    const m = Number(minute)
    const h = Number(hour)
    if (Number.isInteger(m) && Number.isInteger(h) && month === '*') {
      if (dom === '*' && dow === '1-5') return { mode: 'weekdays', hour: h, minute: m }
      if (dom === '*' && dow === '*') return { mode: 'daily', hour: h, minute: m }
      if (dom === '*' && /^[0-6](,[0-6])*$/.test(dow)) {
        return { mode: 'weekly', days: dow.split(',').map(Number), hour: h, minute: m }
      }
      if (dow === '*' && Number.isInteger(Number(dom))) {
        return { mode: 'monthly', day: Number(dom), hour: h, minute: m }
      }
    }
  }
  return { mode: 'custom', cron }
}
