import 'server-only'
import { eq } from 'drizzle-orm'
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
    const [duty] = await app.db
      .select({ sourceRunId: duties.sourceRunId })
      .from(duties)
      .where(eq(duties.id, dutyId))
      .limit(1)
    if (!duty?.sourceRunId) return null

    const [source] = await app.db
      .select({ trigger: runs.trigger })
      .from(runs)
      .where(eq(runs.id, duty.sourceRunId))
      .limit(1)
    const trigger = source?.trigger
    if (!trigger || trigger.type !== 'chat') return null
    // `web:` is the in-app conversation prefix; a Slack or Teams conversation
    // id is not a thread in this database and must not be treated as one.
    if (!trigger.conversationId.startsWith('web:')) return null
    const threadId = trigger.conversationId.slice('web:'.length)
    return threadId.length > 0 ? threadId : null
  })
}
