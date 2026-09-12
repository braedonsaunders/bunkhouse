import 'server-only'

import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { duties, runs, type DeliveryTarget } from '../db/schema'
import { db } from '../db/client'
import { executeAgentRun } from './agent-runs'
import { deliveryInstruction, resolveDeliveryTargets } from './delivery-targets'
import { nextOccurrence, occurrenceAfterSkip } from './duties'
import { isPersonNotWorking } from './person-work'
import { dutyIsSelfDirected, selfDirectedBudget } from './work-budget'

/**
 * A run that has not reached a terminal state: still working, or parked on a wait.
 *
 * A parked run still owns its lane — it is mid-task waiting for an approval or a
 * reply, and starting the same work beside it is the same collision as starting
 * it beside a running one.
 */
const UNFINISHED_RUN_STATUSES = ['running', 'waiting_approval', 'waiting_reply', 'waiting_credential'] as const

/**
 * The duty's own words, plus the recipients it declares.
 *
 * Resolved here — at the moment the occurrence runs — rather than stored
 * alongside the duty, so a recipient whose address changed still receives
 * tomorrow's report. A duty that declares nothing gets its instruction back
 * untouched, which is every duty written before delivery targets existed.
 */
async function instructionWithDelivery(
  tenantId: string,
  duty: { instruction: string; deliverTo: DeliveryTarget[] },
): Promise<string> {
  const targets = duty.deliverTo ?? []
  if (targets.length === 0) return duty.instruction
  const resolved = await resolveDeliveryTargets(tenantId, targets)
  const addendum = deliveryInstruction(resolved)
  return addendum ? `${duty.instruction}\n${addendum}` : duty.instruction
}

/**
 * Claim one scheduled occurrence by comparing the exact due timestamp the
 * heartbeat observed. The schedule advances in the same transaction as the
 * claim, so duplicate queue jobs are harmless and a Redis loss leaves the
 * occurrence visible to the next heartbeat.
 */
export async function executeDueDuty(
  tenantId: string,
  dutyId: string,
  scheduledAt: string | null,
): Promise<void> {
  const app = db()
  const claimed = await app.withTenant(tenantId, async () => {
    const [duty] = await app.db.select().from(duties).where(eq(duties.id, dutyId)).limit(1)
    if (!duty || duty.enabled !== 'on') return null
    const observed = duty.nextDueAt?.toISOString() ?? null
    if (observed !== scheduledAt) return null

    const anchoring = duty.nextDueAt === null && duty.scheduleKind !== 'once'

    // Whether this occurrence is going to produce a run decides whether it costs
    // the duty anything, so the question is asked before the schedule is written
    // rather than after. The budget check used to sit past the claim and simply
    // `return`, which charged a run for work that never happened — on every
    // occurrence, for as long as the budget stayed spent, until a bounded duty
    // had burned its whole allowance on runs that were never attempted.
    const skipped = anchoring
      ? null
      : await (async () => {
          // A duty never runs twice at once.
          //
          // The schedule advances when an occurrence is CLAIMED, not when its run
          // finishes, so a lane whose runs outlast its interval laps itself. A
          // fifteen-minute wake loop taking twenty to thirty-five minutes did
          // exactly that nine times in twelve hours — and on one of them both
          // instances read the same candidate queue, both decided to buy, and the
          // wallet ended up holding twice the intended position. The second
          // instance then spent the rest of its run discovering the first one's
          // trade on-chain, calling it "two signatures I did not create", and
          // unwinding half of it at a loss.
          //
          // Overlap was a documented acceptance in `schedulingAbilities` — "the
          // operator's call to make" — written when the spacing floor came down.
          // That was wrong. Stateful work cannot be run concurrently with itself
          // just because the clock came round again, and the cost of finding out
          // was real money.
          //
          // The occurrence is SKIPPED rather than queued behind the live run: the
          // next one is a minute or fifteen away and will see a settled world,
          // where a backlog would pile identical work behind a slow run and make
          // the lapping worse.
          const [live] = await app.db
            .select({ id: runs.id, startedAt: runs.startedAt })
            .from(runs)
            .where(
              and(
                sql`${runs.trigger}->>'dutyId' = ${duty.id}`,
                inArray(runs.status, [...UNFINISHED_RUN_STATUSES]),
              ),
            )
            .limit(1)
          if (live) {
            return `its previous occurrence is still working (run ${live.id}, started ${live.startedAt.toISOString()})`
          }
          if (!(await dutyIsSelfDirected(duty.id))) return null
          const budget = await selfDirectedBudget(duty.personId)
          return budget.exhausted ? budget.reason : null
        })()

    let next: Date | null
    try {
      next = skipped ? occurrenceAfterSkip(duty) : nextOccurrence(duty)
    } catch (error) {
      await app.db
        .update(duties)
        .set({ enabled: 'off', nextDueAt: null, updatedAt: new Date() })
        .where(eq(duties.id, duty.id))
      throw error
    }

    const [updated] = await app.db
      .update(duties)
      .set({
        nextDueAt: next,
        updatedAt: new Date(),
        ...(anchoring || skipped ? {} : { lastRunAt: new Date(), runCount: duty.runCount + 1 }),
        ...(next === null ? { enabled: 'off' as const } : {}),
      })
      .where(
        and(
          eq(duties.id, duty.id),
          eq(duties.enabled, 'on'),
          duty.nextDueAt === null ? isNull(duties.nextDueAt) : eq(duties.nextDueAt, duty.nextDueAt),
        ),
      )
      .returning()
    if (!updated || anchoring) return null
    if (skipped) {
      console.warn(`[duty] ${updated.title}: skipped — ${skipped}`)
      return null
    }
    return updated
  })
  if (!claimed) return

  try {
    const { outcome } = await executeAgentRun({
      tenantId,
      personId: claimed.personId,
      trigger: { type: 'duty', dutyId: claimed.id },
      input: { type: 'duty', dutyTitle: claimed.title, instruction: await instructionWithDelivery(tenantId, claimed) },
    })
    console.log(`[duty] ${claimed.title}: ${outcome.status}${claimed.nextDueAt ? '' : ' (final run — duty retired)'}`)
  } catch (error) {
    // The occurrence is spent either way — the schedule advanced in the claim
    // above — and the gate has already written the refusal as a run against
    // this duty, so the operator can see the occurrence that did not happen.
    // Re-throwing would only have the queue retry a duty whose agent cannot
    // work; the duty itself stays scheduled for whenever it can.
    if (!isPersonNotWorking(error)) throw error
    console.warn(`[duty] ${claimed.title}: not run — ${error.message}`)
  }
}

