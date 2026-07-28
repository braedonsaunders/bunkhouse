import 'server-only'
import { and, eq } from 'drizzle-orm'
import type { RunOutcome } from '@bunkhouse/runtime'
import { assignments, files, mailMessages, type AssignmentSource } from '../db/schema'
import { db } from '../db/client'
import { executeAgentRun } from './agent-runs'

/**
 * Assignments: committed deliverables executed as background runs. The worker
 * enqueues one job per pending assignment; `runAssignment` claims it (a
 * pending→working transition that only one job can win), does the work, and
 * settles the assignment from the run's outcome. Delivery is verified against
 * the mail ledger — an assignment is 'delivered' only when the run actually
 * sent mail, never because the model said so.
 */

/** Deliverable runs get room to research, draft, render, and deliver. */
export const ASSIGNMENT_MAX_STEPS = 60

function describeSource(source: AssignmentSource): string {
  if (source.kind === 'call') return 'on a call'
  if (source.kind === 'mail') return 'over email'
  if (source.kind === 'delegation') return 'as a delegation from a colleague'
  return 'directly'
}

export async function pendingAssignmentIds(tenantId: string): Promise<string[]> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const rows = await app.db
      .select({ id: assignments.id })
      .from(assignments)
      .where(eq(assignments.status, 'pending'))
    return rows.map((r) => r.id)
  })
}

/**
 * Settle an assignment from its run's outcome. Shared by the initial
 * background execution and by approval-resume continuations of the same run.
 */
export async function finalizeAssignmentRun(
  tenantId: string,
  assignmentId: string,
  runId: string,
  outcome: RunOutcome,
): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    if (outcome.status === 'waiting_approval') {
      await app.db
        .update(assignments)
        .set({ status: 'waiting_approval', updatedAt: new Date() })
        .where(eq(assignments.id, assignmentId))
      return
    }
    if (outcome.status === 'waiting_reply') {
      // Blocked on a person's answer — still in progress; the mailbox pass
      // resumes the run (and re-settles here) when the reply lands.
      await app.db
        .update(assignments)
        .set({ status: 'working', updatedAt: new Date() })
        .where(eq(assignments.id, assignmentId))
      return
    }
    if (outcome.status !== 'completed') {
      const error = outcome.status === 'failed' ? outcome.error : 'Paused: salary budget exhausted.'
      await app.db
        .update(assignments)
        .set({ status: 'failed', lastError: error.slice(0, 500), updatedAt: new Date() })
        .where(eq(assignments.id, assignmentId))
      return
    }
    // Proof of delivery is the mail ledger, not the model's summary.
    const [sent] = await app.db
      .select({ id: mailMessages.id })
      .from(mailMessages)
      .where(and(eq(mailMessages.runId, runId), eq(mailMessages.direction, 'outbound')))
      .limit(1)
    const produced = await app.db.select({ id: files.id }).from(files).where(eq(files.runId, runId))
    if (sent) {
      await app.db
        .update(assignments)
        .set({
          status: 'delivered',
          deliveredAt: new Date(),
          resultFileIds: produced.map((f) => f.id),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(assignments.id, assignmentId))
    } else {
      await app.db
        .update(assignments)
        .set({
          status: 'failed',
          resultFileIds: produced.map((f) => f.id),
          lastError: 'The run finished without sending the deliverable email.',
          updatedAt: new Date(),
        })
        .where(eq(assignments.id, assignmentId))
    }
  })
}

/** Claim one pending assignment and run it to a settled state (or suspension). */
export async function runAssignment(tenantId: string, assignmentId: string): Promise<void> {
  const app = db()
  const claimed = await app.withTenant(tenantId, async () => {
    const [row] = await app.db
      .update(assignments)
      .set({ status: 'working', updatedAt: new Date() })
      .where(and(eq(assignments.id, assignmentId), eq(assignments.status, 'pending')))
      .returning()
    return row ?? null
  })
  if (!claimed) return

  const { runId, outcome } = await executeAgentRun({
    tenantId,
    personId: claimed.personId,
    trigger: { type: 'assignment', assignmentId: claimed.id },
    input: {
      type: 'assignment',
      title: claimed.title,
      spec: claimed.spec,
      deliverTo: claimed.deliverTo,
      formats: claimed.formats,
      ...(claimed.dueAt ? { dueAt: claimed.dueAt.toISOString() } : {}),
      source: describeSource(claimed.source),
    },
    maxSteps: ASSIGNMENT_MAX_STEPS,
    counterparty: claimed.deliverTo,
  })

  await app.withTenant(tenantId, async () => {
    await app.db.update(assignments).set({ runId, updatedAt: new Date() }).where(eq(assignments.id, assignmentId))
  })
  await finalizeAssignmentRun(tenantId, assignmentId, runId, outcome)
}
