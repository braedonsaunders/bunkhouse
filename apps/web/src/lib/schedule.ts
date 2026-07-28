import cronstrue from 'cronstrue'

/**
 * Schedules are stored as cron internally but NEVER shown as cron to
 * operators: display goes through cronToHuman, editing goes through the
 * structured builder (ScheduleSpec ⇄ cron). Advanced cron entry exists only
 * behind the builder's Advanced toggle.
 */
export function cronToHuman(cron: string): string {
  try {
    return cronstrue.toString(cron, { use24HourTimeFormat: false, verbose: false })
  } catch {
    return cron
  }
}

export type ScheduleSpec =
  | { mode: 'weekdays'; hour: number; minute: number }
  | { mode: 'daily'; hour: number; minute: number }
  | { mode: 'weekly'; days: number[]; hour: number; minute: number }
  | { mode: 'monthly'; day: number; hour: number; minute: number }
  | { mode: 'custom'; cron: string }

export function specToCron(spec: ScheduleSpec): string {
  switch (spec.mode) {
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
