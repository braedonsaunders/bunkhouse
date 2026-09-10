import { CronExpressionParser } from 'cron-parser'
import type { duties } from '../db/schema'

/**
 * When a duty fires next. The duties table is the source of truth for
 * scheduling — the worker polls `next_due_at` on its tick rather than holding
 * a timer or a queue entry per duty, so schedules survive a Redis flush, stay
 * inside tenant RLS, and remain editable in the People UI.
 *
 * Every kind funnels through here so the worker never re-implements the
 * "when next" question:
 *   cron     — a repeating pattern, resolved in the duty's timezone
 *   interval — every N minutes, measured from the last fire
 *   once     — a single absolute instant; nothing follows it
 */

export type Duty = typeof duties.$inferSelect

/** The scheduling fields, so callers can ask about a duty before inserting it. */
export type ScheduleInput = Pick<Duty, 'scheduleKind' | 'schedule'> &
  Partial<Pick<Duty, 'timezone' | 'startsAt' | 'endsAt'>>

export class ScheduleError extends Error {}

/**
 * How many times a schedule may fire — `null` for as long as it is wanted.
 *
 * A repeat used to be capped at twelve runs unless a person in the conversation
 * had asked for it, and the cap was applied whether or not anyone had asked for
 * a cap. Two things followed from that, both bad:
 *
 * A duty-triggered run was never in a "person asked" context, so a lane could
 * not renew itself as ongoing — only as another bounded twelve. Agents therefore
 * built renewal chains out of bounded bookings to keep continuous work alive,
 * which is the behaviour the ceiling existed to prevent, and every renewal left
 * another dead `-2`, `-3`, `-4` duty behind it.
 *
 * And the default quietly decided something nobody had decided. A watch lane
 * asked for in plain words stopped after twelve passes with no notice and a null
 * next run, which reads as the platform having lost it.
 *
 * So the bound is the agent's to choose, and absent a choice there is none. The
 * guardrails that remain are the ones that fail loudly at booking time rather
 * than silently twelve runs later: a floor on how often a schedule may repeat, a
 * ceiling on how many a person may hold at once, and the spend budget, which
 * skips an occurrence and says so.
 */
export function scheduledRunLimit(input: { kind: 'once' | 'cron'; maxRuns?: number }): number | null {
  // A one-shot has nothing to bound: it happens, and `nextOccurrence` retires it.
  if (input.kind === 'once') return null
  return input.maxRuns ?? null
}

/** The instant a `once` duty is pinned to. */
function parseOnce(schedule: string): Date {
  const at = new Date(schedule)
  if (Number.isNaN(at.getTime())) throw new ScheduleError('A one-time duty needs a valid date and time.')
  return at
}

/** Advance a repeating pattern to its first occurrence strictly after `after`. */
function advance(input: ScheduleInput, after: Date): Date {
  if (input.scheduleKind === 'interval') {
    const minutes = Number(input.schedule)
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new ScheduleError('An interval duty repeats every N minutes, where N is a positive number.')
    }
    return new Date(after.getTime() + minutes * 60_000)
  }
  try {
    return CronExpressionParser.parse(input.schedule, {
      currentDate: after,
      // Without a zone, cron resolves in the worker process's timezone — which
      // is not where the operator lives.
      tz: input.timezone ?? undefined,
    })
      .next()
      .toDate()
  } catch (error) {
    if (error instanceof ScheduleError) throw error
    throw new ScheduleError(`That schedule could not be read: ${(error as Error).message}`)
  }
}

/**
 * The first time a new or rescheduled duty should fire, or null if its bounds
 * mean it never can (an end date already past, a one-shot with no future).
 */
export function firstOccurrence(input: ScheduleInput, from: Date = new Date()): Date | null {
  const startsAt = input.startsAt ?? null
  const after = startsAt && startsAt > from ? startsAt : from
  const next = input.scheduleKind === 'once' ? parseOnce(input.schedule) : advance(input, after)
  const endsAt = input.endsAt ?? null
  if (endsAt && next > endsAt) return null
  return next
}

/**
 * The occurrence after the one that just fired — null when the duty is spent
 * and the caller should retire it. A one-shot is always spent; a recurrence is
 * spent once it passes its end date or exhausts its run budget.
 */
export function nextOccurrence(duty: Duty, from: Date = new Date()): Date | null {
  if (duty.scheduleKind === 'once') return null
  // runCount is the tally *before* this run, so the run now firing is the
  // (runCount + 1)th — at the cap, there is no occurrence after it.
  if (duty.maxRuns !== null && duty.runCount + 1 >= duty.maxRuns) return null
  return firstOccurrence(duty, from)
}

/**
 * The occurrence after one that was claimed but never became a run.
 *
 * The schedule still has to move — the occurrence is gone and must not fire
 * twice — but nothing ran, so it costs the duty nothing. That makes the
 * arithmetic differ from `nextOccurrence` by exactly one: no run is being
 * counted here, so the *next* occurrence is the (runCount + 1)th and the cap
 * bites a step later.
 *
 * Without this, a duty skipped because its owner's self-directed budget was
 * spent was charged a run for work that never happened — silently, and on every
 * occurrence until the budget refreshed.
 */
export function occurrenceAfterSkip(duty: Duty, from: Date = new Date()): Date | null {
  if (duty.scheduleKind === 'once') return null
  if (duty.maxRuns !== null && duty.runCount >= duty.maxRuns) return null
  return firstOccurrence(duty, from)
}

/** Validate a schedule at authoring time, surfacing the operator-facing reason. */
export function assertSchedule(input: ScheduleInput): void {
  firstOccurrence(input)
}

/**
 * The gap between a repeating schedule's next two occurrences, in minutes.
 * Used to keep an agent from scheduling itself into a tight loop — a duty that
 * fires every minute would spend the tenant's budget with no one watching.
 * Infinite for a one-shot, which by definition has no second occurrence.
 */
export function gapMinutes(input: ScheduleInput, from: Date = new Date()): number {
  if (input.scheduleKind === 'once') return Infinity
  const first = firstOccurrence(input, from)
  if (!first) return Infinity
  const second = firstOccurrence(input, first)
  if (!second) return Infinity
  return (second.getTime() - first.getTime()) / 60_000
}
