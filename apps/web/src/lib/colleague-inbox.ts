import 'server-only'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { colleagueMessages, people, runs, tokenSpend } from '../db/schema'
import { db } from '../db/client'

/**
 * The inbox, and what one human ask is allowed to cost.
 *
 * Both of these exist because of the same afternoon. Four test phone calls —
 * four runs, twenty cents — turned into 913 assignments and fifty-three
 * dollars, and the titles of the work say precisely what it was:
 * `Re: Re: Re: Re: Daily check-in outcome — posture confirmed`. Agents
 * acknowledging each other's acknowledgements, each acknowledgement a full
 * model run, because every internal message had been made into a job.
 *
 * Messages are no longer jobs; they wait here until the recipient is working
 * anyway. But "messages are cheap" is not on its own a governor — the deeper
 * hole was that nothing recorded which human ask a piece of work descended
 * from, so nothing could say what one request had cost, and nothing could stop
 * it. The only thing that noticed nine hundred assignments was the invoice.
 *
 * So every run carries a root: the call, the email, the operator action it
 * came from. Work derived from one carries the same root however far it
 * spreads, and the spend under a root is checked before more derived work
 * starts. A request that has already cost more than it could possibly be worth
 * stops, and says so, instead of quietly continuing.
 */

/**
 * What one human ask may spend before work derived from it stops.
 *
 * Generous for anything a person actually asked for — an afternoon of research
 * costs well under this — and far below where a runaway is discovered on an
 * invoice. It bounds a REQUEST, which is a different question from the salary
 * meter's "what may this agent spend this month": the meter would have let a
 * single test call run to the monthly ceiling and only then stopped the agent
 * entirely, days later, with the money already gone.
 */
export const MAX_SPEND_PER_ROOT_USD = 3

/** And how many pieces of derived work, for the case that is cheap but endless. */
export const MAX_DERIVED_RUNS_PER_ROOT = 40

export type RootBudget = { spentUsd: number; runs: number; exhausted: boolean; reason?: string }

/**
 * What everything descending from one ask has cost so far. Assumes an active
 * tenant scope.
 */
export async function rootBudget(rootRunId: string): Promise<RootBudget> {
  const app = db()
  const [row] = await app.db
    .select({
      runs: sql<number>`count(distinct ${runs.id})`.mapWith(Number),
      spent: sql<number>`coalesce(sum(${tokenSpend.costUsd}), 0)`.mapWith(Number),
    })
    .from(runs)
    .leftJoin(tokenSpend, eq(tokenSpend.runId, runs.id))
    .where(eq(runs.rootRunId, rootRunId))

  const spentUsd = row?.spent ?? 0
  const count = row?.runs ?? 0
  if (spentUsd >= MAX_SPEND_PER_ROOT_USD) {
    return {
      spentUsd,
      runs: count,
      exhausted: true,
      reason: `Everything stemming from this one request has already cost $${spentUsd.toFixed(2)}, which is the ceiling for a single ask. Finish with what you have and tell the person what is outstanding rather than starting more work on it.`,
    }
  }
  if (count >= MAX_DERIVED_RUNS_PER_ROOT) {
    return {
      spentUsd,
      runs: count,
      exhausted: true,
      reason: `This one request has already produced ${count} separate pieces of work. Whatever is still unfinished needs a person to look at it, not another handoff.`,
    }
  }
  return { spentUsd, runs: count, exhausted: false }
}

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
