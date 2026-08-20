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
    where r.status in ('running', 'waiting_approval', 'waiting_reply', 'waiting_credential')
    order by r.started_at limit 40
  `),
  ['agent', 'trigger', 'status', 'started', 'minutes', 'events', 'last_event'],
)


// --- what actually went wrong ------------------------------------------------
// The error ledger, grouped. One agent saying a tool is broken is an anecdote;
// the same message across twenty runs is the thing to fix.
table(
  'Errors recorded',
  await rows(sql`
    select left(e.payload->>'message', 90) as message, count(*) as times, count(distinct e.run_id) as runs,
           string_agg(distinct p.name, ', ') as agents
    from run_events e join runs r on r.id = e.run_id join people p on p.id = r.person_id
    where e.kind = 'error' and r.started_at > ${since}
    group by 1 order by count(*) desc limit 20
  `),
  ['message', 'times', 'runs', 'agents'],
)

// --- what an agent believes about itself -------------------------------------
// An agent's logbook outlives the thing it describes. A note saved while a
// capability was genuinely missing keeps being read back long after the
// capability lands, and the agent goes on working around a wall that is no
// longer there — rescheduling, following up, asking a person to do what it
// could now do itself. search_memory being the most-called tool of the night
// is what made this worth asking.
table(
  'Notes claiming something does not work',
  await rows(sql`
    select p.name as agent, left(m.title, 46) as note, m.kind,
           to_char(m.created_at, 'Mon DD') as saved,
           case when m.valid_until is null then 'live' else 'superseded' end as state,
           left(regexp_replace(m.body, '\\s+', ' ', 'g'), 90) as body
    from memories m join people p on p.id = m.person_id
    where m.body ~* '(no automatic executor|not available to me|cannot |can.t |fails|failing|not implemented|no executor|unable to)'
    order by m.created_at desc limit 25
  `),
  ['agent', 'note', 'kind', 'saved', 'state', 'body'],
)

// --- context growth ----------------------------------------------------------
// Input tokens per model call is the tell for a run that resends an ever-larger
// transcript — screenshots especially — every single step.
table(
  'Input tokens per model call, by agent and model',
  await rows(sql`
    select p.name as agent, s.model, count(*) as calls,
           round(avg(s.input_tokens)) as avg_input_per_call,
           max(s.input_tokens) as biggest_single_call,
           round(sum(s.cost_usd)::numeric, 4) as cost_usd
    from token_spend s join people p on p.id = s.person_id
    where s.created_at > ${since}
    group by p.name, s.model order by avg(s.input_tokens) desc
  `),
  ['agent', 'model', 'calls', 'avg_input_per_call', 'biggest_single_call', 'cost_usd'],
)

// --- what everything is parked on -------------------------------------------
// A run waiting on approval is not spending, but it already spent everything it
// took to get there — and it stays waiting until a person acts. A screenful of
// them is either a dial set too tight or nobody being told.
table(
  'Waiting on an approval',
  await rows(sql`
    select p.name as agent, r.trigger->>'type' as trigger,
           a.category, left(coalesce(a.payload->>'description', ''), 60) as awaiting,
           round(extract(epoch from (now() - a.created_at))/60) as minutes,
           round(coalesce((select sum(cost_usd) from token_spend s where s.run_id = r.id), 0)::numeric, 4) as cost_usd
    from approvals a
    join runs r on r.id = a.run_id
    join people p on p.id = a.person_id
    where a.status = 'pending'
    order by a.created_at limit 40
  `),
  ['agent', 'trigger', 'category', 'awaiting', 'minutes', 'cost_usd'],
)

// --- which dial is doing the parking ----------------------------------------
table(
  'Autonomy dial, per agent',
  await rows(sql`
    select p.name as agent, a.category, a.level
    from autonomy_settings a join people p on p.id = a.person_id
    order by p.name, a.category
  `),
  ['agent', 'category', 'level'],
)

// --- can anyone even be told ------------------------------------------------
// "Could not email the approval request (ECONNREFUSED 127.0.0.1:1025)" — a
// mailbox pointed at a development mail catcher that does not exist here.
table(
  'Mailboxes, as configured',
  await rows(sql`
    select p.name as agent, m.address,
           m.provider, m.imap->>'smtpHost' as smtp_host, m.imap->>'smtpPort' as smtp_port,
           m.imap->>'imapHost' as imap_host, m.status, left(coalesce(m.last_error, ''), 50) as last_error
    from mailbox_accounts m join people p on p.id = m.person_id
    order by p.name
  `),
  ['agent', 'address', 'provider', 'smtp_host', 'smtp_port', 'imap_host', 'status', 'last_error'],
)

// --- how work multiplied ----------------------------------------------------
// The question a total cannot answer: four phone calls became nine hundred
// assignments, and the only way to see how is to look at where each one came
// from and who sent it to whom.
table(
  'Assignments by where they came from',
  await rows(sql`
    select a.source->>'kind' as source,
           coalesce(f.name, '—') as sent_by,
           p.name as landed_on,
           count(*) as assignments,
           round(coalesce(sum(s.cost_usd), 0)::numeric, 4) as cost_usd
    from assignments a
    join people p on p.id = a.person_id
    left join people f on f.id = (a.source->>'fromPersonId')::uuid
    left join token_spend s on s.run_id = a.run_id
    where a.created_at > ${since}
    group by 1, 2, 3 order by count(*) desc limit 20
  `),
  ['source', 'sent_by', 'landed_on', 'assignments', 'cost_usd'],
)

table(
  'What they kept sending each other',
  await rows(sql`
    select left(a.title, 62) as title, count(*) as times,
           coalesce(f.name, '—') as sent_by, p.name as landed_on,
           to_char(min(a.created_at), 'HH24:MI') as first_at,
           to_char(max(a.created_at), 'HH24:MI') as last_at
    from assignments a
    join people p on p.id = a.person_id
    left join people f on f.id = (a.source->>'fromPersonId')::uuid
    where a.created_at > ${since}
    group by 1, 3, 4 order by count(*) desc limit 20
  `),
  ['title', 'times', 'sent_by', 'landed_on', 'first_at', 'last_at'],
)

// The depth a chain reached. hops rides on the assignment's own source.
table(
  'How deep the chains went',
  await rows(sql`
    select coalesce(a.source->>'hops', '(none recorded)') as hops, count(*) as assignments
    from assignments a where a.created_at > ${since} and a.source->>'kind' = 'delegation'
    group by 1 order by 1
  `),
  ['hops', 'assignments'],
)

// --- what each of them actually did -----------------------------------------
// A per-agent breakdown, because a total says money moved and not what for. An
// agent whose tools are all reading and writing notes is an agent producing
// reports about nothing.
table(
  'Tools called, per agent',
  await rows(sql`
    select p.name as agent, e.payload->>'toolName' as tool, count(*) as calls
    from run_events e join runs r on r.id = e.run_id join people p on p.id = r.person_id
    where e.kind = 'tool_call' and r.started_at > ${since}
    group by 1, 2 order by p.name, count(*) desc
  `),
  ['agent', 'tool', 'calls'],
)

table(
  'What their runs concluded',
  await rows(sql`
    select p.name as agent, to_char(r.started_at, 'HH24:MI') as at,
           r.trigger->>'type' as trigger,
           left(regexp_replace(coalesce(r.summary, ''), '\\s+', ' ', 'g'), 110) as summary
    from runs r join people p on p.id = r.person_id
    where r.started_at > ${since} and r.summary is not null
    order by r.started_at desc limit 25
  `),
  ['agent', 'at', 'trigger', 'summary'],
)

// --- what they did to the outside world -------------------------------------
// Reading and writing notes is an agent talking to itself; this is everything
// that actually touched something real, with the input it used and the ask it
// descended from. The question "who asked for this?" has to be answerable.
table(
  'Every action that touched something outside',
  await rows(sql`
    select p.name as agent,
           to_char(e.created_at, 'MM-DD HH24:MI') as at,
           e.payload->>'toolName' as tool,
           left(regexp_replace(coalesce(e.payload->>'input', ''), '\\s+', ' ', 'g'), 95) as input,
           r.trigger->>'type' as trigger,
           coalesce(rt.trigger->>'type', '(is the ask)') as root_was
    from run_events e
    join runs r on r.id = e.run_id
    join people p on p.id = r.person_id
    left join runs rt on rt.id = r.root_run_id
    where e.kind = 'tool_call'
      and r.started_at > ${since}
      and (e.payload->>'toolName' ~ '^(netsuite|place_call|send_email|create_|browser_open|web_search|run_shell)')
    order by e.created_at desc limit 40
  `),
  ['agent', 'at', 'tool', 'input', 'trigger', 'root_was'],
)

const [total] = await rows(sql`
  select round(coalesce(sum(cost_usd), 0)::numeric, 4) as cost_usd, count(*) as model_calls
  from token_spend where created_at > ${since}
`)
console.log(`\nTotal over the window: ${money(total?.cost_usd)} across ${total?.model_calls ?? 0} model calls.`)
process.exit(0)
