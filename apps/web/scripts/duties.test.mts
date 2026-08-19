import assert from 'node:assert/strict'
import {
  firstOccurrence,
  gapMinutes,
  MAX_SELF_SCHEDULED_REPEATS,
  nextOccurrence,
  scheduledRunLimit,
  ScheduleError,
  type Duty,
} from '../src/lib/duties'

const NOW = new Date('2026-07-28T12:00:00Z')

function duty(over: Partial<Duty>): Duty {
  return {
    scheduleKind: 'cron',
    schedule: '0 9 * * 1',
    timezone: null,
    startsAt: null,
    endsAt: null,
    maxRuns: null,
    runCount: 0,
    ...over,
  } as Duty
}

// --- one-time ---------------------------------------------------------------
const at = '2026-08-01T15:30:00.000Z'
assert.equal(firstOccurrence({ scheduleKind: 'once', schedule: at }, NOW)?.toISOString(), at)
assert.equal(nextOccurrence(duty({ scheduleKind: 'once', schedule: at }), NOW), null, 'one-shot never repeats')
assert.throws(() => firstOccurrence({ scheduleKind: 'once', schedule: 'not a date' }, NOW), ScheduleError)

// --- cron + timezone --------------------------------------------------------
// 9am Monday in New York is 13:00Z in August (EDT), not 09:00Z.
const ny = firstOccurrence({ scheduleKind: 'cron', schedule: '0 9 * * 1', timezone: 'America/New_York' }, NOW)
assert.equal(ny?.toISOString(), '2026-08-03T13:00:00.000Z', `tz-aware cron, got ${ny?.toISOString()}`)
const utc = firstOccurrence({ scheduleKind: 'cron', schedule: '0 9 * * 1', timezone: 'UTC' }, NOW)
assert.equal(utc?.toISOString(), '2026-08-03T09:00:00.000Z')

// --- interval ---------------------------------------------------------------
assert.equal(
  firstOccurrence({ scheduleKind: 'interval', schedule: '90' }, NOW)?.toISOString(),
  '2026-07-28T13:30:00.000Z',
)
assert.throws(() => firstOccurrence({ scheduleKind: 'interval', schedule: '0' }, NOW), ScheduleError)

// --- bounds -----------------------------------------------------------------
assert.equal(
  firstOccurrence({ scheduleKind: 'cron', schedule: '0 9 * * 1', endsAt: new Date('2026-07-30T00:00:00Z') }, NOW),
  null,
  'end date before the next occurrence retires the duty',
)
assert.equal(
  firstOccurrence(
    { scheduleKind: 'cron', schedule: '0 9 * * *', timezone: 'UTC', startsAt: new Date('2026-09-01T00:00:00Z') },
    NOW,
  )?.toISOString(),
  '2026-09-01T09:00:00.000Z',
  'start date defers the first run',
)
assert.equal(nextOccurrence(duty({ maxRuns: 3, runCount: 2 }), NOW), null, '3rd of 3 runs is the last')
assert.notEqual(nextOccurrence(duty({ maxRuns: 3, runCount: 1 }), NOW), null, '2nd of 3 runs has a successor')
assert.equal(nextOccurrence(duty({ maxRuns: 1, runCount: 0 }), NOW), null, 'a limit of 1 fires exactly once')

// --- self-scheduling guardrail ----------------------------------------------
// gapMinutes is what stops an agent booking itself into a tight loop.
assert.equal(gapMinutes({ scheduleKind: 'cron', schedule: '* * * * *', timezone: 'UTC' }, NOW), 1, 'every minute')
assert.equal(gapMinutes({ scheduleKind: 'cron', schedule: '0 9 * * *', timezone: 'UTC' }, NOW), 1440, 'daily')
assert.equal(gapMinutes({ scheduleKind: 'interval', schedule: '30' }, NOW), 30)
assert.equal(gapMinutes({ scheduleKind: 'once', schedule: at }, NOW), Infinity, 'a one-shot never loops')
// A bounded recurrence with no second occurrence is not a loop either.
assert.equal(
  gapMinutes({ scheduleKind: 'cron', schedule: '0 9 * * *', timezone: 'UTC', endsAt: new Date('2026-07-29T12:00:00Z') }, NOW),
  Infinity,
)

// --- bad input surfaces as an operator-readable error ------------------------
assert.throws(() => firstOccurrence({ scheduleKind: 'cron', schedule: 'not cron' }, NOW), ScheduleError)

// A person's explicit standing routine remains active until cancelled; an
// employee's own follow-up stays bounded even if the model omits maxRuns.
assert.equal(scheduledRunLimit({ kind: 'cron', standing: true, standingAllowed: true }), null)
assert.equal(
  scheduledRunLimit({ kind: 'cron', standing: false, standingAllowed: false }),
  MAX_SELF_SCHEDULED_REPEATS,
)
assert.equal(scheduledRunLimit({ kind: 'cron', standing: false, standingAllowed: false, maxRuns: 3 }), 3)
assert.throws(
  () => scheduledRunLimit({ kind: 'cron', standing: true, standingAllowed: false }),
  ScheduleError,
)
assert.equal(scheduledRunLimit({ kind: 'once', standing: false, standingAllowed: false }), null)

console.log('duties scheduling: all assertions passed')
