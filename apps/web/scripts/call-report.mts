import { sql } from 'drizzle-orm'
import { db } from '../src/db/client'

/**
 * One call, second by second — what was said, what the agent was doing while it
 * said it, and where the silences were.
 *
 * The observatory shows a call's ledger and the transcript separately, which is
 * the wrong shape for the only question that matters about a call that felt
 * wrong: what was happening in the gap. A caller having to ask "are you still
 * there?" is not a transcript problem or a tool problem — it is the two of them
 * side by side, with the clock between them.
 *
 * Read-only, and it runs inside the container that already holds the database
 * URL. Turn text is real dialogue and is printed in full, because a call cannot
 * be diagnosed from a summary of itself.
 *
 *   tsx apps/web/scripts/call-report.mts "Bill McDonald" [howManyCallsBack]
 */

const WHO = process.argv[2] ?? ''
const BACK = Math.max(1, Number(process.argv[3] ?? 1))
const app = db()

const rows = async (query: ReturnType<typeof sql>) =>
  (await app.withSuperAdmin((superDb) => superDb.execute(query))).rows as Record<string, unknown>[]

const [session] = await rows(sql`
  select cs.id, cs.tenant_id, cs.run_id, cs.room, cs.direction, cs.status,
         cs.started_at, cs.duration_seconds, cs.recording_file_id,
         p.name as agent, cs.counterparty->>'name' as caller
  from call_sessions cs join people p on p.id = cs.person_id
  where (${WHO} = '' or p.name ilike ${`%${WHO}%`})
  order by cs.started_at desc
  offset ${BACK - 1} limit 1
`)

if (!session) {
  console.log(`No call found for "${WHO}".`)
  process.exit(0)
}

console.log(
  `${session.agent} — ${session.direction}, ${session.status}, ${session.duration_seconds ?? '?'}s, started ${session.started_at}`,
)
console.log(`caller: ${session.caller ?? 'unknown'}   room: ${session.room}`)
console.log(`recording: ${session.recording_file_id ? 'kept' : 'NONE'}`)

/** mm:ss.t from a millisecond offset, so gaps are readable at a glance. */
const clock = (ms: number) => {
  const s = ms / 1000
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`
}

// The two streams, merged on the clock. Turns carry their own offset; ledger
// events carry a timestamp, so they are converted to the same origin.
const started = new Date(String(session.started_at)).getTime()

const turns = (
  await rows(sql`
    select seq, speaker, text, at_ms from call_turns where session_id = ${session.id} order by seq
  `)
).map((row) => ({
  at: Number(row.at_ms),
  kind: 'turn' as const,
  who: String(row.speaker),
  text: String(row.text).replace(/\s+/g, ' ').trim(),
}))

const events = session.run_id
  ? (
      await rows(sql`
        select kind, payload, created_at from run_events where run_id = ${session.run_id} order by seq
      `)
    ).map((row) => {
      const payload = (row.payload ?? {}) as Record<string, unknown>
      const label =
        row.kind === 'tool_call'
          ? `→ ${payload.toolName}(${JSON.stringify(payload.input ?? {}).slice(0, 90)})`
          : row.kind === 'tool_result'
            ? // A failing result is the interesting one and 90 characters cut
              // a NetSuite 403 off before it said which permission was
              // missing. Successes stay short; failures get room to explain.
              `← ${payload.toolName} ${JSON.stringify(payload.output ?? {}).slice(
                0,
                /error|403|denied|fail/i.test(JSON.stringify(payload.output ?? {}).slice(0, 200)) ? 500 : 90,
              )}`
            : row.kind === 'message'
              ? `· ${String(payload.text ?? '').replace(/\s+/g, ' ').slice(0, 120)}`
              : `${row.kind}: ${String(payload.message ?? payload.trace ?? '')
                  .replace(/\s+/g, ' ')
                  .slice(0, 120)}`
      return {
        at: new Date(String(row.created_at)).getTime() - started,
        kind: 'event' as const,
        who: String(row.kind),
        text: label,
      }
    })
  : []

const timeline = [...turns, ...events].sort((a, b) => a.at - b.at)

console.log('\n=== the call, with the clock between ===')
console.log('(a gap is how long the caller waited with nothing coming back)\n')
let previous = 0
for (const item of timeline) {
  const gap = item.at - previous
  // Four seconds of nothing is a pause a person notices on a phone call.
  const marker = gap >= 4000 ? `   <<< ${(gap / 1000).toFixed(1)}s of silence` : ''
  if (marker) console.log(marker)
  const who = item.kind === 'turn' ? (item.who === 'agent' ? 'AGENT ' : 'CALLER') : '      '
  console.log(`${clock(item.at)} ${who} ${item.text}`)
  previous = item.at
}

// The last thing the agent said before it hung up is its own question: a call
// that ends without a goodbye reads to the caller as a dropped line.
const spoken = turns.filter((t) => t.who === 'agent')
const hangup = events.find((e) => e.text.includes('end_call'))
console.log('\n=== how it ended ===')
console.log(`last thing the agent said: ${spoken.at(-1)?.text ?? '(nothing)'}`)
console.log(`end_call: ${hangup ? `at ${clock(hangup.at)}` : 'not called — the caller hung up'}`)
if (hangup) {
  const after = spoken.filter((t) => t.at > hangup.at - 500)
  console.log(`spoken between the last word and the hangup: ${after.length === 0 ? 'NOTHING' : after.length}`)
}

const gaps = timeline
  .map((item, i) => ({ at: item.at, gap: i === 0 ? item.at : item.at - timeline[i - 1]!.at }))
  .filter((g) => g.gap >= 4000)
  .sort((a, b) => b.gap - a.gap)
console.log(`\nsilences over 4s: ${gaps.length}${gaps.length ? ` — longest ${(gaps[0]!.gap / 1000).toFixed(1)}s at ${clock(gaps[0]!.at)}` : ''}`)
process.exit(0)
