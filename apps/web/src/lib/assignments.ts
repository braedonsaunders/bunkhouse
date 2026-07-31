import 'server-only'
import { and, eq } from 'drizzle-orm'
import type { RunOutcome } from '@bunkhouse/runtime'
import { assignments, files, mailMessages, people, type AssignmentSource } from '../db/schema'
import { hopsOf, postToColleague } from './colleague-post'
import { db } from '../db/client'
import { ASSIGNMENT_MAX_STEPS, executeAgentRun } from './agent-runs'
import { rootBudget, selfDirectedBudget } from './work-budget'

/**
 * Assignments: committed deliverables executed as background runs. The worker
 * enqueues one job per pending assignment; `runAssignment` claims it (a
 * pending→working transition that only one job can win), does the work, and
 * settles the assignment from the run's outcome. Delivery is verified against
 * the mail ledger — an assignment is 'delivered' only when the run actually
 * sent mail, never because the model said so.
 */

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
    const [assignment] = await app.db.select().from(assignments).where(eq(assignments.id, assignmentId))
    const produced = await app.db.select({ id: files.id }).from(files).where(eq(files.runId, runId))

    // Proof of delivery is the ledger, not the model's summary — but WHICH
    // ledger depends on who was waiting. Work a colleague handed over comes
    // back to that colleague inside the company: there is no mail in it, so
    // requiring an outbound email marked every delegated assignment 'failed'
    // however well it had gone, and an agent with no mailbox could never
    // finish one at all.
    const delegated = assignment?.source.kind === 'delegation' ? assignment.source : null
    if (delegated) {
      const [worker] = await app.db.select().from(people).where(eq(people.id, assignment!.personId))
      const back = await postToColleague({
        tenantId,
        from: {
          id: assignment!.personId,
          name: worker?.name ?? 'your colleague',
          title: worker?.title ?? '',
          email: worker?.email ?? '',
        },
        toEmail: assignment!.deliverTo.address,
        title: `Re: ${assignment!.title}`,
        body: outcome.summary.trim() || 'Finished, with nothing further to report.',
        runId,
        hops: hopsOf(assignment!.source),
        returning: true,
        // The answer to something they asked for is information, not a new
        // job. Making it a job is half of why one delegation used to cost two
        // runs and could start a third.
        kind: 'message',
      })
      await app.db
        .update(assignments)
        .set({
          status: back.posted ? 'delivered' : 'failed',
          ...(back.posted ? { deliveredAt: new Date() } : { lastError: back.reason.slice(0, 500) }),
          resultFileIds: produced.map((f) => f.id),
          updatedAt: new Date(),
        })
        .where(eq(assignments.id, assignmentId))
      return
    }

    const [sent] = await app.db
      .select({ id: mailMessages.id })
      .from(mailMessages)
      .where(and(eq(mailMessages.runId, runId), eq(mailMessages.direction, 'outbound')))
      .limit(1)
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

  // What the whole request has cost so far. A ceiling on ONE ASK is a different
  // question from the salary meter's ceiling on one agent's month: the meter
  // would have let four test phone calls run to the monthly limit and only
  // then stopped the agent entirely, days later, with the money gone. This
  // stops the request instead, while everything else carries on.
  const root =
    claimed.source.kind === 'delegation' ? (claimed.source.rootRunId ?? claimed.source.runId ?? null) : null
  // Requested work is bounded by what the request has cost; work nobody asked
  // for is bounded by the day. An agent that found its own mailbox broken spent
  // a day investigating it, and every one of those runs was its own root, so a
  // per-ask ceiling never touched it.
  const budget = root
    ? await app.withTenant(tenantId, () => rootBudget(root))
    : await app.withTenant(tenantId, () => selfDirectedBudget(claimed.personId))
  {
    if (budget.exhausted) {
      await app.withTenant(tenantId, async () => {
        await app.db
          .update(assignments)
          .set({ status: 'failed', lastError: budget.reason!.slice(0, 500), updatedAt: new Date() })
          .where(eq(assignments.id, assignmentId))
      })
      console.warn(`[assignments] ${assignmentId} stopped: ${budget.reason}`)
      return
    }
  }

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
