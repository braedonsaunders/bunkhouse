import 'server-only'
import { sql } from 'drizzle-orm'
import { duties, runs } from '../db/schema'
import { db } from '../db/client'

/**
 * The conversation a duty was born in.
 *
 * A duty run is triggered by the clock, so its own trigger carries no
 * conversation — and for a long time that meant scheduled work had no way back
 * into chat at all. An agent asked in a thread to deliver something every
 * morning would do the work on time, write the delivery, and have nowhere to
 * put it; the report went into the run summary, which nobody is reading at
 * 08:30. The person who asked saw silence and reasonably concluded the agent
 * had forgotten.
 *
 * Nothing new has to be recorded to fix that. `duties.source_run_id` already
 * preserves "the run in which an employee created this duty", and when that
 * run was a chat turn its trigger names the exact thread. The delivery address
 * has been sitting in the data the whole time, unread.
 *
 * Returns null whenever the chain does not resolve — a duty created by an
 * operator in the UI or instantiated from a role pack has no conversation to
 * go home to, and inventing one would put a stranger's report into a thread
 * nobody associated with it. Those keep whatever delivery they already had.
 */
export async function dutyConversationThreadId(
  tenantId: string,
  dutyId: string,
): Promise<string | null> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    // Walk the chain, not one link of it.
    //
    // Reading only `duties.source_run_id` found the conversation exactly once:
    // for a duty booked in a chat turn. An agent that re-books its own lane does
    // so from inside a SCHEDULED run, and a duty run's trigger carries a dutyId
    // rather than a conversation — so the replacement resolved to null and was
    // born mute. It then fell back to email and reported "no mailbox is
    // connected", while the lane it replaced had been posting fine for days.
    //
    // Nothing is lost when that happens, which is the point: the run that booked
    // the new duty names the OLD duty, and that duty names the run that booked
    // it. The address is still reachable, just further back. On the live tenant a
    // watch lane was three renewals deep and still led to the original chat turn.
    //
    // Bounded rather than unbounded: a renewal chain is a few links in practice,
    // a cycle is possible in principle, and a duty whose origin is genuinely not
    // a conversation must come back null rather than spin.
    const rows = await app.db.execute(sql`
      with recursive chain as (
        select d.id, d.source_run_id, 0 as hop
          from ${duties} d
         where d.id = ${dutyId}
        union all
        select next_duty.id, next_duty.source_run_id, chain.hop + 1
          from chain
          join ${runs} source on source.id = chain.source_run_id
           and source.trigger->>'type' = 'duty'
           and source.trigger->>'dutyId' ~ '^[0-9a-fA-F-]{36}$'
          join ${duties} next_duty on next_duty.id = (source.trigger->>'dutyId')::uuid
         where chain.hop < 16
           and next_duty.id <> chain.id
      )
      select origin.trigger->>'conversationId' as conversation
        from chain
        join ${runs} origin on origin.id = chain.source_run_id
       where origin.trigger->>'type' = 'chat'
       order by chain.hop
       limit 1
    `)
    const conversation = (rows.rows[0] as { conversation?: unknown } | undefined)?.conversation
    if (typeof conversation !== 'string') return null
    // `web:` is the in-app conversation prefix; a Slack or Teams conversation
    // id is not a thread in this database and must not be treated as one.
    if (!conversation.startsWith('web:')) return null
    const threadId = conversation.slice('web:'.length)
    return threadId.length > 0 ? threadId : null
  })
}

/**
 * The same relationship read the other way: which duties belong to one thread.
 *
 * The conversation pane finds a thread's work by matching
 * `trigger->>'conversationId'`, and a duty run has none — so scheduled work was
 * invisible in the very conversation that asked for it. Avery's half-hourly scan
 * ran on time, used the shell, wrote its result, and the thread showed the last
 * CHAT run's terminal instead. During an outage that meant a reader saw "the
 * desk could not be reached" hours after the desk was fixed, with the working
 * runs nowhere in sight: stale output presented as the current state.
 *
 * `post_to_conversation` already uses this provenance to decide where a duty may
 * SPEAK ({@link dutyConversationThreadId}). The surfaces that show what the work
 * did have to agree with it, or the conversation claims one thing and its own
 * work surface another.
 *
 * One query, not one per run: resolve the thread's duties up front, then match
 * run triggers against that set.
 */
export async function threadDutyIds(tenantId: string, threadId: string): Promise<string[]> {
  if (!threadId) return []
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    // Walked the same number of links as `dutyConversationThreadId`, for the same
    // reason it must be: if this finds fewer duties than that one will speak for,
    // the conversation shows a reader one set of work while the agent posts from
    // another. A self-renewed lane was invisible here and audible there.
    //
    // `union` rather than `union all`: deduplication is what terminates this if a
    // renewal chain ever loops back on itself.
    const rows = await app.db.execute(sql`
      with recursive rooted as (
        select d.id
          from ${duties} d
          join ${runs} origin on origin.id = d.source_run_id
         where origin.trigger->>'conversationId' = ${`web:${threadId}`}
        union
        select renewed.id
          from rooted
          join ${runs} booked_in
            on booked_in.trigger->>'type' = 'duty'
           and booked_in.trigger->>'dutyId' = rooted.id::text
          join ${duties} renewed on renewed.source_run_id = booked_in.id
      )
      select id from rooted
    `)
    return rows.rows.map((row) => String((row as { id: unknown }).id))
  })
}
