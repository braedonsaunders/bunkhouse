import 'server-only'
import { and, eq, gte, isNull, sql } from 'drizzle-orm'
import { duties, runs, tokenSpend } from '../db/schema'
import { db } from '../db/client'

/**
 * What a piece of work is allowed to cost, and the two different questions
 * that turns out to be.
 *
 * The salary meter answers a third question — what may this agent spend this
 * month — and it is the wrong instrument for both of these. It would have let
 * four test phone calls run to the monthly ceiling and then stopped the agent
 * entirely, days later, with the money already gone.
 *
 * ONE ASK. A call, an inbound email, an operator pressing go: work derived
 * from it carries its root, and everything under that root shares one pot.
 * A request that has cost more than any request could be worth stops, and
 * says so, while everything else carries on.
 *
 * NOBODY ASKED. The harder one, and the one that actually happened. An agent
 * found its own mailbox broken and decided that was a problem worth solving:
 * a day of NetSuite queries looking for a message table to send mail through,
 * the employee table for addresses it already had, saved searches, gateway
 * tests, two guesses at how a colleague's address is spelled. Every one of
 * those runs was its own root, so a per-ask ceiling never bit. Nobody asked
 * for any of it.
 *
 * Self-directed work is not wrong — noticing something and saying so is what a
 * good colleague does. Spending a day on it without being asked is not. So it
 * gets a small daily allowance: enough to notice, investigate briefly and
 * report; not enough to disappear into its own infrastructure.
 */

/** What one human ask may spend before work derived from it stops. */
export const MAX_SPEND_PER_ROOT_USD = 3

/** And how many pieces of derived work, for the case that is cheap but endless. */
export const MAX_DERIVED_RUNS_PER_ROOT = 40

/**
 * What one agent may spend in a day on work nobody asked for.
 *
 * Deliberately small. A day of unrequested investigation cost more than every
 * phone call in the same period by two orders of magnitude, and produced
 * nothing anybody wanted.
 */
export const MAX_SELF_DIRECTED_USD_PER_DAY = 1

export type WorkBudget = { spentUsd: number; runs: number; exhausted: boolean; reason?: string }

/** What everything descending from one ask has cost. Assumes a tenant scope. */
export async function rootBudget(rootRunId: string): Promise<WorkBudget> {
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

/**
 * Is this duty one a person set up, or one the agent booked for itself?
 *
 * `createdBy` is stamped with the agent's own id by `schedule_task`, and with
 * an operator's by everything else, so the distinction is already recorded —
 * it had simply never been asked.
 */
export async function dutyIsSelfDirected(dutyId: string): Promise<boolean> {
  const app = db()
  const [row] = await app.db
    .select({
      personId: duties.personId,
      createdBy: duties.createdBy,
      fromPack: duties.fromRolePackDuty,
      sourceTrigger: runs.trigger,
    })
    .from(duties)
    .leftJoin(runs, eq(runs.id, duties.sourceRunId))
    .where(eq(duties.id, dutyId))
  if (!row) return false
  const requested =
    row.sourceTrigger?.type === 'chat' ||
    row.sourceTrigger?.type === 'email' ||
    row.sourceTrigger?.type === 'manual'
  return row.fromPack === null && row.createdBy === row.personId && !requested
}

/**
 * What this agent has spent today on work nobody asked for.
 *
 * Self-directed means the run roots in the agent itself: a duty it wrote for
 * itself, or work with no human ask anywhere above it. A run that descends
 * from a call, an inbound email, an operator, or a duty a person configured is
 * requested work and is not counted here.
 *
 * Assumes an active tenant scope.
 */
export async function selfDirectedBudget(personId: string): Promise<WorkBudget> {
  const app = db()
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const [row] = await app.db
    .select({
      runs: sql<number>`count(distinct ${runs.id})`.mapWith(Number),
      spent: sql<number>`coalesce(sum(${tokenSpend.costUsd}), 0)`.mapWith(Number),
    })
    .from(runs)
    .leftJoin(tokenSpend, eq(tokenSpend.runId, runs.id))
    .where(
      and(
        eq(runs.personId, personId),
        gte(runs.startedAt, since),
        isNull(runs.rootRunId),
        // Requested work roots in the request. What is left — an assignment an
        // agent handed itself, a schedule it wrote for itself — is its own idea.
        sql`${runs.trigger} ->> 'type' not in ('chat', 'email', 'approval_followup')`,
        sql`not (${runs.trigger} ->> 'type' = 'duty' and exists (
          select 1 from duties d
          where d.id = (${runs.trigger} ->> 'dutyId')::uuid
            and (d.created_by is distinct from d.person_id or d.from_role_pack_duty is not null)
        ))`,
      ),
    )

  const spentUsd = row?.spent ?? 0
  const count = row?.runs ?? 0
  if (spentUsd >= MAX_SELF_DIRECTED_USD_PER_DAY) {
    return {
      spentUsd,
      runs: count,
      exhausted: true,
      reason: `You have already spent $${spentUsd.toFixed(2)} today on work nobody asked you for, which is the daily limit for that. If something is genuinely wrong, say so once, plainly, to a person — do not keep investigating it. Work somebody actually asked for is unaffected.`,
    }
  }
  return { spentUsd, runs: count, exhausted: false }
}
