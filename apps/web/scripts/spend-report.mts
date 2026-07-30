import { sql } from 'drizzle-orm'
import { db } from '../src/db/client'

/**
 * Where the money went, and what the agents were doing when it went.
 *
 * Written for a morning that started with "a bunch of agents worked overnight
 * racking up a bill and nobody knows what they were doing". The observatory
 * shows runs one at a time, which is the wrong shape for that question: what
 * it takes to answer is the whole night at once — who ran, how often, what
 * started them, how many of them were running at the same time, and what they
 * spent their steps on.
 *
 * Strictly read-only, and it runs INSIDE a container that already holds the
 * database URL so that URL never has to be handed to anything else. Aggregates
 * only: no message bodies, no page contents, no recipient addresses.
 *
 *   tsx apps/web/scripts/spend-report.mts [hours]
 */

const HOURS = Number(process.argv[2] ?? 24)
const app = db()

const money = (value: unknown) => `$${Number(value ?? 0).toFixed(4)}`
const rows = async (query: ReturnType<typeof sql>) =>
  (await app.withSuperAdmin((superDb) => superDb.execute(query))).rows as Record<string, unknown>[]

const table = (title: string, data: Record<string, unknown>[], columns: string[]) => {
  console.log(`\n=== ${title} ===`)
  if (data.length === 0) {
    console.log('(nothing)')
    return
  }
  const widths = columns.map((col) => Math.max(col.length, ...data.map((row) => String(row[col] ?? '').length)))
  console.log(columns.map((col, i) => col.padEnd(widths[i]!)).join('  '))
  for (const row of data) {
    console.log(columns.map((col, i) => String(row[col] ?? '').padEnd(widths[i]!)).join('  '))
  }
}

const since = sql.raw(`now() - interval '${HOURS} hours'`)

console.log(`Spend and activity, last ${HOURS} hours. Generated inside the running container.`)

// --- the bill, by agent ------------------------------------------------------
table(
  'Spend by agent',
  await rows(sql`
    select p.name as agent,
           count(distinct s.run_id) as runs,
           count(*) as model_calls,
           round(sum(s.cost_usd)::numeric, 4) as cost_usd,
           sum(s.input_tokens) as input_tokens,
           sum(s.output_tokens) as output_tokens,
           string_agg(distinct s.model, ', ') as models
    from token_spend s join people p on p.id = s.person_id
    where s.created_at > ${since}
    group by p.name order by sum(s.cost_usd) desc
  `),
  ['agent', 'runs', 'model_calls', 'cost_usd', 'input_tokens', 'output_tokens', 'models'],
)

// --- what started them -------------------------------------------------------
// The single most useful column on this page. A night of spend under 'duty' is
// a schedule firing too often; under 'email' it is a loop between two
// mailboxes; under 'assignment' it is real work that ran long.
table(
  'What started the runs',
  await rows(sql`
    select r.trigger->>'type' as trigger,
           r.status,
           count(*) as runs,
           round(coalesce(sum(s.cost_usd), 0)::numeric, 4) as cost_usd,
           round(avg(extract(epoch from (coalesce(r.finished_at, now()) - r.started_at)))::numeric, 0) as avg_seconds
    from runs r left join token_spend s on s.run_id = r.id
    where r.started_at > ${since}
    group by 1, 2 order by count(*) desc
  `),
  ['trigger', 'status', 'runs', 'cost_usd', 'avg_seconds'],
)

// --- the same thing, over and over ------------------------------------------
// Repetition is the signature of a runaway schedule: the same agent, the same
// trigger, many times an hour, all night.
table(
  'Busiest hours',
  await rows(sql`
    select to_char(date_trunc('hour', r.started_at), 'Mon DD HH24:00') as hour,
           count(*) as runs_started,
           count(distinct r.person_id) as agents,
           round(coalesce(sum(s.cost_usd), 0)::numeric, 4) as cost_usd
    from runs r left join token_spend s on s.run_id = r.id
    where r.started_at > ${since}
    group by date_trunc('hour', r.started_at)
    order by date_trunc('hour', r.started_at)
  `),
  ['hour', 'runs_started', 'agents', 'cost_usd'],
)

// --- one agent, several at once ---------------------------------------------
// "Multiple concurrent per agent" was the reported symptom, so it gets its own
// question: for each agent, the most runs that were ever open at the same time.
table(
  'Most concurrent runs per agent',
  await rows(sql`
    with bounds as (
      select person_id, started_at as at, 1 as delta from runs where started_at > ${since}
      union all
      select person_id, coalesce(finished_at, now()), -1 from runs where started_at > ${since}
    ), running as (
      select person_id, at, sum(delta) over (partition by person_id order by at, delta desc) as open
      from bounds
    )
    select p.name as agent, max(running.open) as most_at_once
    from running join people p on p.id = running.person_id
    group by p.name order by max(running.open) desc
  `),
  ['agent', 'most_at_once'],
)

// --- the expensive individual runs ------------------------------------------
table(
  'Priciest runs',
  await rows(sql`
    select p.name as agent,
           r.trigger->>'type' as trigger,
           r.status,
           to_char(r.started_at, 'Mon DD HH24:MI') as started,
           round(extract(epoch from (coalesce(r.finished_at, now()) - r.started_at))::numeric, 0) as seconds,
           (select count(*) from run_events e where e.run_id = r.id and e.kind = 'tool_call') as tool_calls,
           round(sum(s.cost_usd)::numeric, 4) as cost_usd,
           left(coalesce(r.summary, ''), 70) as summary
    from token_spend s join runs r on r.id = s.run_id join people p on p.id = r.person_id
    where s.created_at > ${since}
    group by p.name, r.id, r.trigger, r.status, r.started_at, r.finished_at, r.summary
    order by sum(s.cost_usd) desc limit 15
  `),
  ['agent', 'trigger', 'status', 'started', 'seconds', 'tool_calls', 'cost_usd', 'summary'],
)

// --- what they actually did --------------------------------------------------
// A run that called one tool four hundred times is a loop; a run spread across
// many tools was working. The distinction is the diagnosis.
table(
  'Tools called',
  await rows(sql`
    select e.payload->>'toolName' as tool, count(*) as calls, count(distinct e.run_id) as runs,
           max(per_run.calls) as most_in_one_run
    from run_events e
    join runs r on r.id = e.run_id
    join lateral (
      select count(*) as calls from run_events e2
      where e2.run_id = e.run_id and e2.kind = 'tool_call' and e2.payload->>'toolName' = e.payload->>'toolName'
    ) per_run on true
    where e.kind = 'tool_call' and r.started_at > ${since}
    group by 1 order by count(*) desc limit 20
  `),
  ['tool', 'calls', 'runs', 'most_in_one_run'],
)

// --- schedules, which is usually the answer ---------------------------------
table(
  'Duties that fired',
  await rows(sql`
    select p.name as agent,
           left(d.title, 40) as duty,
           d.schedule::text as schedule,
           count(r.id) as fired,
           round(coalesce(sum(s.cost_usd), 0)::numeric, 4) as cost_usd
    from runs r
    join people p on p.id = r.person_id
    left join duties d on d.id = (r.trigger->>'dutyId')::uuid
    left join token_spend s on s.run_id = r.id
    where r.started_at > ${since} and r.trigger->>'type' = 'duty'
    group by p.name, d.title, d.schedule::text
    order by count(r.id) desc limit 20
  `),
  ['agent', 'duty', 'schedule', 'fired', 'cost_usd'],
)

// --- runs still open ---------------------------------------------------------
table(
  'Still running now',
  await rows(sql`
    select p.name as agent, r.trigger->>'type' as trigger, r.status,
           to_char(r.started_at, 'Mon DD HH24:MI') as started,
           round(extract(epoch from (now() - r.started_at))/60) as minutes,
           (select count(*) from run_events e where e.run_id = r.id) as events,
           to_char((select max(created_at) from run_events e where e.run_id = r.id), 'HH24:MI:SS') as last_event
    from runs r join people p on p.id = r.person_id
    where r.status in ('running', 'waiting_approval', 'waiting_reply')
    order by r.started_at limit 40
  `),
  ['agent', 'trigger', 'status', 'started', 'minutes', 'events', 'last_event'],
)

const [total] = await rows(sql`
  select round(coalesce(sum(cost_usd), 0)::numeric, 4) as cost_usd, count(*) as model_calls
  from token_spend where created_at > ${since}
`)
console.log(`\nTotal over the window: ${money(total?.cost_usd)} across ${total?.model_calls ?? 0} model calls.`)
process.exit(0)
