import { sql } from 'drizzle-orm'
import { db } from '../src/db/client'

/**
 * Clearing up after the runaway — counting first, and never deleting.
 *
 * A day of agents writing to each other left three kinds of residue, and all
 * three keep costing something until they are cleared:
 *
 *   * hundreds of episodic notes about attempts, retries and acknowledgements,
 *     which are re-read into the top of every subsequent run;
 *   * queued and in-flight work that only exists because a message was
 *     mistaken for a job, which the worker will happily still run;
 *   * self-scheduled polling duties waiting to fire again tomorrow.
 *
 * Nothing here deletes. Notes are CLOSED the way the app closes them —
 * `valid_until`, which is what "forgetting" already means in this schema, and
 * leaves every word readable in history. Work is CANCELLED, which is a real
 * status the UI understands. Duties are switched off, not removed, so it stays
 * obvious what an agent had booked for itself.
 *
 * Counts, unless TIDY_APPLY=true. Housekeeping on live data that cannot be
 * previewed is not housekeeping, it is a gamble.
 *
 *   tsx apps/web/scripts/tidy-agents.mts
 */

const APPLY = process.env.TIDY_APPLY === 'true'
const app = db()

const rows = async (query: ReturnType<typeof sql>) =>
  (await app.withSuperAdmin((superDb) => superDb.execute(query))).rows as Record<string, unknown>[]

const show = (title: string, data: Record<string, unknown>[]) => {
  console.log(`\n=== ${title} ===`)
  if (data.length === 0) return console.log('(nothing)')
  for (const row of data) console.log(Object.entries(row).map(([k, v]) => `${k}=${v}`).join('  '))
}

console.log(APPLY ? 'APPLYING — this changes live data.' : 'DRY RUN — counting only. Nothing is changed.')

// --- what is there ----------------------------------------------------------
show(
  'Episodic notes an agent wrote about its own day',
  await rows(sql`
    select p.name as agent, count(*) as notes,
           to_char(min(m.created_at), 'MM-DD') as oldest, to_char(max(m.created_at), 'MM-DD HH24:MI') as newest
    from memories m join people p on p.id = m.person_id
    where m.scope = 'agent' and m.valid_until is null and m.status = 'active'
      and m.kind = 'episode' and m.pinned = false
    group by p.name order by count(*) desc
  `),
)

show(
  'Work still queued or running',
  await rows(sql`
    select p.name as agent, a.status, a.source->>'kind' as source, count(*) as work
    from assignments a join people p on p.id = a.person_id
    where a.status in ('pending', 'working', 'waiting_approval')
    group by p.name, a.status, a.source->>'kind' order by count(*) desc
  `),
)

show(
  'Schedules the agents wrote for themselves',
  await rows(sql`
    select p.name as agent, left(d.title, 54) as duty, d.schedule, d.run_count, d.enabled
    from duties d join people p on p.id = d.person_id
    where d.created_by = d.person_id and d.from_role_pack_duty is null and d.enabled = 'on'
    order by d.run_count desc
  `),
)

show(
  'Approvals nobody has decided',
  await rows(sql`
    select p.name as agent, a.category, count(*) as pending
    from approvals a join people p on p.id = a.person_id
    where a.status = 'pending' group by p.name, a.category order by count(*) desc
  `),
)

if (!APPLY) {
  console.log('\nNothing changed. Re-run with tidyApply ticked to carry this out.')
  process.exit(0)
}

// --- carry it out -----------------------------------------------------------
// Pinned notes are what a human curated deliberately; facts, procedures and
// reflections are conclusions rather than diary. Only the diary is closed.
const closed = await rows(sql`
  update memories set valid_until = now(), pinned = false, updated_at = now()
  where scope = 'agent' and valid_until is null and status = 'active'
    and kind = 'episode' and pinned = false
  returning id
`)
console.log(`\nclosed ${closed.length} episodic note(s) — still readable in history`)

// Work that exists only because a message was mistaken for a job. Anything a
// person is actually waiting on comes back the moment they ask again.
const cancelled = await rows(sql`
  update assignments
     set status = 'cancelled',
         last_error = 'Cancelled during housekeeping: this was a message the system had turned into a job.',
         updated_at = now()
   where status in ('pending', 'working')
  returning id
`)
console.log(`cancelled ${cancelled.length} queued piece(s) of work`)

const paused = await rows(sql`
  update duties set enabled = 'off', updated_at = now()
  where created_by = person_id and from_role_pack_duty is null and enabled = 'on'
  returning id, title
`)
console.log(`switched off ${paused.length} self-scheduled duty(s) — still listed, not deleted`)
for (const duty of paused) console.log(`  · ${duty.title}`)

// Approvals for work that no longer exists would otherwise sit in the queue
// for ever, and every one of them is noise in front of a real decision. The
// link is through the run's own trigger to the assignment that was cancelled —
// cancelling the work does not touch the run it was going to use.
//
// 'rejected' is what this enum calls it. 'declined' is not a value and the
// first version of this failed on exactly that, after the other three
// statements had already gone through.
const dropped = await rows(sql`
  update approvals set status = 'rejected',
      decision_note = 'Rejected during housekeeping: the work it belonged to was cancelled.',
      decided_at = now()
  where status = 'pending'
    and exists (
      select 1 from runs r join assignments a on a.id = (r.trigger ->> 'assignmentId')::uuid
      where r.id = approvals.run_id
        and r.trigger ->> 'type' = 'assignment'
        and a.status = 'cancelled'
    )
  returning id
`)
console.log(`rejected ${dropped.length} approval(s) whose work is already gone`)
console.log('\nDone. Nothing was deleted.')
process.exit(0)
