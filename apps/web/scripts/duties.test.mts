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

// --- a duty run the worker lost is closed, not left claiming to work --------
//
// The abandoned-work sweep only ever matched `trigger->>'type' = 'assignment'`,
// so a duty run killed mid-step stayed `running` for good. A rolling deploy does
// exactly that: a half-hourly duty fired on time twice and both runs went silent
// the moment a container was replaced, while the duty had already advanced its
// own next_due_at — so the schedule appeared to produce nothing, twice, behind
// two runs that still said they were working. It compounds for a chat turn,
// because recoverChatDispatches only settles a dispatch once its linked run has
// stopped, pinning that thread in queue-only mode.
{
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const worker = readFileSync(fileURLToPath(new URL('./worker.mts', import.meta.url)), 'utf8')
  const sweep = worker.slice(worker.indexOf('async function abandonedWorkPass'))
  assert.ok(
    sweep.includes("coalesce(r.trigger->>'type', '') <> 'assignment'"),
    'the sweep closes abandoned runs of every other trigger kind, not only assignments',
  )
  assert.ok(
    sweep.includes("set status = 'failed'") && sweep.includes('finished_at = now()'),
    'an abandoned run is finished on the record rather than left running',
  )
  assert.ok(
    sweep.includes("r.status = 'running'"),
    'only a run still claiming to work is swept — a waiting run is not abandoned',
  )
  // Deliberately not retried: a run that died mid-step may already have sent
  // mail or moved money, and the idempotency ledger guards a replayed effect,
  // not a whole re-run. The duty's next occurrence is the retry.
  assert.equal(
    /update\s+duties/i.test(sweep),
    false,
    'the sweep never re-arms a duty — a correction is a new record, not a replayed run',
  )

  // --- and the deploy that killed them gets a drain -------------------------
  //
  // The SIGTERM handler always called BullMQ's non-forced close(), which does
  // wait for an active job — it just never got the chance, because no
  // stop_grace_period was configured and Swarm's default is ten seconds.
  const shutdown = worker.slice(worker.indexOf('async function shutdown'))
  assert.ok(
    shutdown.indexOf('worker.pause(true)') < shutdown.indexOf('worker.close()'),
    'claiming stops before the drain waits, so the grace period goes to work already in flight',
  )
  assert.ok(
    shutdown.includes('deepWorker.pause(true)'),
    'the deep-work queue stops claiming too — that is where runs execute',
  )
  assert.ok(
    shutdown.includes('inFlightRunIds()') && shutdown.includes("status = 'failed'"),
    'whatever the drain could not finish is recorded immediately, not left to the sweep',
  )
  assert.ok(
    shutdown.includes('if (draining) return'),
    'a second signal during a drain does not tear the drain down',
  )

  // The drain budget must stay INSIDE the container's grace period: past it the
  // container is SIGKILLed and none of the recording above happens. These two
  // numbers live in different files and have to be changed together.
  const budgetMs = Number(/const DRAIN_BUDGET_MS = ([\d_]+)/.exec(worker)?.[1]?.replaceAll('_', ''))
  assert.ok(Number.isFinite(budgetMs) && budgetMs > 0, 'the drain budget is a readable number')
  const compose = readFileSync(
    fileURLToPath(new URL('../../../deploy/dokploy.compose.yaml', import.meta.url)),
    'utf8',
  )
  const graceSeconds = Number(
    /worker:[\s\S]*?stop_grace_period:\s*(\d+)s/.exec(compose)?.[1],
  )
  assert.ok(
    Number.isFinite(graceSeconds) && graceSeconds > 10,
    'the worker has a stop_grace_period longer than Swarm’s ten-second default',
  )
  assert.ok(
    budgetMs < graceSeconds * 1_000,
    `the drain budget (${budgetMs}ms) must finish inside the grace period (${graceSeconds}s)`,
  )

  // The web container runs chat turns INSIDE the request, so it needs its own
  // window. Without one a deploy SIGKILLed a turn mid-step and left it claiming
  // to be `running`, with the person's next messages queued behind it and the
  // conversation looking dead until the thirty-minute sweep noticed.
  const webGrace = Number(/web:[\s\S]*?stop_grace_period:\s*(\d+)s/.exec(compose)?.[1])
  assert.ok(Number.isFinite(webGrace), 'the web service has a stop_grace_period')
  const route = readFileSync(
    fileURLToPath(new URL('../src/app/api/chat/[threadId]/route.ts', import.meta.url)),
    'utf8',
  )
  const maxDuration = Number(/export const maxDuration = (\d+)/.exec(route)?.[1])
  assert.ok(Number.isFinite(maxDuration), 'the chat route states how long a turn may run')
  assert.ok(
    webGrace >= maxDuration,
    `a turn the route allows ${maxDuration}s must not be killed after ${webGrace}s`,
  )
}

console.log('duties scheduling: all assertions passed')
