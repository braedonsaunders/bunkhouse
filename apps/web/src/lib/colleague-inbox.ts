import 'server-only'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { colleagueMessages, people } from '../db/schema'
import { db } from '../db/client'

/**
 * The inbox: what a colleague said, waiting until you are working anyway.
 *
 * Two agents at one company have to be able to say something to each other
 * without it becoming a job and without it becoming a memory. Both were tried
 * and both were wrong. As an assignment, every message was a full model run —
 * which is where `Re: Re: Re: Re: Daily check-in outcome` came from, agents
 * acknowledging each other's acknowledgements at ten cents a time. As a note
 * in the recipient's logbook it stopped costing runs but polluted the one
 * place an agent keeps what it has LEARNED, competing for the retrieval budget
 * and ageing through consolidation beside real facts. A message is not a
 * lesson.
 *
 * So it waits here instead, and is handed over — and marked read — the next
 * time the recipient works, whatever started them.
 */

export type InboxMessage = { from: string; subject: string; body: string; sentAt: Date }

/**
 * Everything a colleague has said to this agent that it has not read yet, and
 * marking it read in the same breath — a message delivered twice is how an
 * agent ends up answering the same thing repeatedly.
 *
 * Bounded like anything else that rides in a context window: the newest handful
 * in full, and an honest count of what was left. Assumes an active tenant scope.
 */
export async function takeInbox(args: { personId: string; limit?: number }): Promise<InboxMessage[]> {
  const app = db()
  const limit = args.limit ?? 10
  const waiting = await app.db
    .select({
      id: colleagueMessages.id,
      subject: colleagueMessages.subject,
      body: colleagueMessages.body,
      createdAt: colleagueMessages.createdAt,
      from: people.name,
    })
    .from(colleagueMessages)
    .leftJoin(people, eq(people.id, colleagueMessages.fromPersonId))
    .where(and(eq(colleagueMessages.toPersonId, args.personId), isNull(colleagueMessages.readAt)))
    .orderBy(asc(colleagueMessages.createdAt))
    .limit(limit)
  if (waiting.length === 0) return []

  await app.db
    .update(colleagueMessages)
    .set({ readAt: new Date(), updatedAt: new Date() })
    .where(
      inArray(
        colleagueMessages.id,
        waiting.map((row) => row.id),
      ),
    )

  return waiting.map((row) => ({
    from: row.from ?? 'a colleague',
    subject: row.subject,
    body: row.body,
    sentAt: row.createdAt,
  }))
}
