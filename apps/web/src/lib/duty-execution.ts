import 'server-only'

import { and, eq, isNull } from 'drizzle-orm'
import { duties } from '../db/schema'
import { db } from '../db/client'
import { executeAgentRun } from './agent-runs'
import { nextOccurrence } from './duties'
import { isPersonNotWorking } from './person-work'
import { dutyIsSelfDirected, selfDirectedBudget } from './work-budget'

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
    let next: Date | null
    try {
      next = nextOccurrence(duty)
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
        ...(anchoring ? {} : { lastRunAt: new Date(), runCount: duty.runCount + 1 }),
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
    return updated
  })
  if (!claimed) return

  if (await app.withTenant(tenantId, () => dutyIsSelfDirected(claimed.id))) {
    const budget = await app.withTenant(tenantId, () => selfDirectedBudget(claimed.personId))
    if (budget.exhausted) {
      console.warn(`[duty] ${claimed.title}: skipped — ${budget.reason}`)
      return
    }
  }

  try {
    const { outcome } = await executeAgentRun({
      tenantId,
      personId: claimed.personId,
      trigger: { type: 'duty', dutyId: claimed.id },
      input: { type: 'duty', dutyTitle: claimed.title, instruction: claimed.instruction },
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

