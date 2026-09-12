import assert from 'node:assert/strict'
import {
  firstOccurrence,
  gapMinutes,
  nextOccurrence,
  occurrenceAfterSkip,
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

// --- a run budget is the agent's to set, or nobody's -------------------------
//
// A repeat used to be capped at twelve unless a person in the conversation had
// asked for it — and the cap was applied whether or not anyone had asked for a
// cap. Two things followed, both bad.
//
// The default decided something nobody had decided. A watch lane asked for in
// plain words stopped after twelve passes, inactive with a null next run, which
// reads as the platform having lost it. On the live tenant that retired all
// fifteen of one agent's standing duties.
//
// And the exemption was unreachable from the place that needed it: a
// duty-triggered run is not a conversation, so a lane could only ever renew
// itself as another bounded twelve. Agents built renewal chains to keep
// continuous work alive — exactly the behaviour the ceiling was added to prevent
// — and left a dead `-2`, `-3`, `-4` duty behind on every renewal.
assert.equal(scheduledRunLimit({ kind: 'cron' }), null, 'no cap unless one is asked for')
assert.equal(scheduledRunLimit({ kind: 'cron', maxRuns: 3 }), 3, 'and the agent may still choose one')
assert.equal(scheduledRunLimit({ kind: 'cron', maxRuns: 5_000 }), 5_000, 'with no ceiling over it')
assert.equal(scheduledRunLimit({ kind: 'once' }), null, 'a one-shot has nothing to bound')
// Nothing about this decision can throw any more: there is no permission to fail.
assert.doesNotThrow(() => scheduledRunLimit({ kind: 'cron' }))

// An uncapped recurrence therefore never runs out, however many times it fires.
assert.notEqual(nextOccurrence(duty({ maxRuns: null, runCount: 10_000 }), NOW), null)

// And the retrofit pass that stamped the old default onto duties already running
// is gone. Aiming it better was not the fix: the duty is mid-flight, nobody asked
// for a bound, and the failure is silent and total.
{
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const worker = readFileSync(fileURLToPath(new URL('./worker.mts', import.meta.url)), 'utf8')
  assert.equal(
    /update duties set max_runs/.test(worker),
    false,
    'nothing writes a run budget onto a duty that is already running',
  )
  const abilities = readFileSync(
    fileURLToPath(new URL('../src/lib/agent-abilities.ts', import.meta.url)),
    'utf8',
  )
  assert.equal(
    /allowStandingSchedules|standingAllowed/.test(abilities),
    false,
    'an ongoing schedule needs no permission, so the gate is gone rather than defaulted open',
  )
  // The tool has to say what the absence of maxRuns means, or the model keeps
  // guessing a bound — which is how the renewal chains started.
  assert.match(abilities, /repeats until cancelled/, 'the description states the new default')
}

// --- the closest an agent may book itself is the platform's real resolution ---
//
// The floor was fifteen minutes, which was never a property of the platform: the
// duty pass ticks every sixty seconds, so a one-minute schedule is serviced on the
// next tick like any other. Fifteen was a guess standing in for runaway protection
// and the agent reported it to people as though it were physics — work that wants
// watching every minute could not be booked at all.
{
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const abilities = readFileSync(
    fileURLToPath(new URL('../src/lib/agent-abilities.ts', import.meta.url)),
    'utf8',
  )
  const floor = Number(/const MIN_SELF_SCHEDULE_GAP_MINUTES = (\d+)/.exec(abilities)?.[1])
  assert.equal(floor, 1, 'an agent may book a repeat as close together as the platform can service')

  // And the floor must stay honest about what the platform can service: slowing
  // the duty pass without raising this would make the refusal message a lie.
  const worker = readFileSync(fileURLToPath(new URL('./worker.mts', import.meta.url)), 'utf8')
  const tickMs = Number(
    /upsertJobScheduler\('duties', \{ every: ([\d_]+) \}/.exec(worker)?.[1]?.replaceAll('_', ''),
  )
  assert.ok(Number.isFinite(tickMs), 'the duty pass states its cadence')
  assert.ok(
    floor * 60_000 >= tickMs,
    `a ${floor}-minute floor cannot be serviced by a pass that ticks every ${tickMs}ms`,
  )

  // The refusal has to read as a sentence at a floor of one, not "every 1".
  assert.match(abilities, /once a minute/, 'the refusal reads properly at the floor')
  assert.equal(
    /the closest you can schedule yourself is every \$\{MIN_SELF_SCHEDULE_GAP_MINUTES\}/.test(abilities),
    false,
    'the old wording is gone',
  )
}

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

// --- an occurrence that never ran costs the duty nothing ---------------------
//
// The schedule still advances — the occurrence is gone and must not fire twice —
// but the run budget is for runs. The self-directed budget check used to sit past
// the claim and `return`, so a duty skipped for a spent budget was charged a run
// for work that was never attempted, on every occurrence until the budget
// refreshed. A bounded duty could retire having run nothing at all.
assert.equal(
  occurrenceAfterSkip(duty({ maxRuns: 12, runCount: 11 }), NOW)?.toISOString(),
  nextOccurrence(duty({ maxRuns: 12, runCount: 10 }), NOW)?.toISOString(),
  'skipping is exactly one run cheaper than running',
)
// The cap still bites, one step later than it would for a real run.
assert.notEqual(occurrenceAfterSkip(duty({ maxRuns: 3, runCount: 2 }), NOW), null, 'the 3rd run is still owed')
assert.equal(nextOccurrence(duty({ maxRuns: 3, runCount: 2 }), NOW), null, 'but after it actually runs, it is spent')
assert.equal(occurrenceAfterSkip(duty({ maxRuns: 3, runCount: 3 }), NOW), null, 'a spent duty stays spent')
assert.equal(occurrenceAfterSkip(duty({ maxRuns: null, runCount: 500 }), NOW) !== null, true, 'standing never runs out')
assert.equal(occurrenceAfterSkip(duty({ scheduleKind: 'once', schedule: at }), NOW), null, 'a one-shot never repeats')

{
  const { readFileSync } = await import('node:fs')
  const execution = readFileSync(new URL('../src/lib/duty-execution.ts', import.meta.url), 'utf8')
  const claim = execution.slice(execution.indexOf('export async function executeDueDuty'))
  // The decision must precede the write, or the charge has already happened.
  assert.ok(
    claim.indexOf('selfDirectedBudget') < claim.indexOf('.update(duties)'),
    'the budget is consulted before the schedule is written, not after',
  )
  assert.match(claim, /anchoring \|\| skipped \? \{\} : \{ lastRunAt/, 'a skipped occurrence increments nothing')
  assert.match(claim, /skipped \? occurrenceAfterSkip\(duty\) : nextOccurrence\(duty\)/, 'and counts one fewer run')
}

// --- a duty never runs twice at once ----------------------------------------
//
// The schedule advances when an occurrence is CLAIMED, not when its run finishes,
// so a lane whose runs outlast its interval laps itself. A fifteen-minute wake
// loop taking twenty to thirty-five minutes did exactly that nine times in twelve
// hours. On one of them both instances read the same candidate queue, both decided
// to buy, and the wallet ended up holding twice the intended position — the second
// instance then spent its run discovering the first one's trade on-chain, calling
// it "two signatures I did not create", and unwinding half at a loss.
//
// This was a documented acceptance ("the operator's call to make") written when
// the spacing floor came down. Stateful work cannot be run concurrently with
// itself just because the clock came round again.
{
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const execution = readFileSync(fileURLToPath(new URL('../src/lib/duty-execution.ts', import.meta.url)), 'utf8')
  const claim = execution.slice(execution.indexOf('export async function executeDueDuty'))

  // The check has to sit in the SKIP decision, which runs before the schedule is
  // written — a later check would have already charged the occurrence a run.
  const decision = claim.slice(0, claim.indexOf('.update(duties)'))
  assert.match(decision, /dutyId' = \$\{duty\.id\}/, 'it asks whether this duty already has a run')
  assert.match(decision, /UNFINISHED_RUN_STATUSES/, 'against every state that is not terminal')

  // A parked run still owns the lane: it is mid-task waiting on a person, and
  // starting the same work beside it is the same collision.
  for (const status of ['running', 'waiting_approval', 'waiting_reply', 'waiting_credential']) {
    assert.match(execution, new RegExp(`'${status}'`), `${status} counts as still working`)
  }
  assert.equal(
    /UNFINISHED_RUN_STATUSES[\s\S]{0,200}'completed'/.test(execution),
    false,
    'a finished run never blocks the next occurrence',
  )

  // Skipped, not queued: a backlog would pile identical work behind a slow run
  // and make the lapping worse. The skip path spends no run budget either.
  assert.match(claim, /occurrenceAfterSkip\(duty\)/, 'a skipped occurrence costs the duty nothing')
  assert.match(claim, /anchoring \|\| skipped \? \{\} : \{ lastRunAt/, 'and increments nothing')

  // And the comment that blessed overlapping is gone, so the next reader does not
  // re-derive it as intended behaviour.
  const abilities = readFileSync(fileURLToPath(new URL('../src/lib/agent-abilities.ts', import.meta.url)), 'utf8')
  assert.equal(
    /an occurrence is not suppressed\s+\*? ?while the previous one is still working/.test(abilities),
    false,
    'the documented acceptance of self-overlap is withdrawn',
  )
}

console.log('duties scheduling: all assertions passed')
