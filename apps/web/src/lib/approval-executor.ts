import 'server-only'
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import type { Ability } from '@bunkhouse/runtime'
import { approvals, people, runs } from '../db/schema'
import { db } from '../db/client'
import { assembleAbilities } from './agent-abilities'
import { ASSIGNMENT_MAX_STEPS, executeAgentRun, replyToThreadAbility, threadIsInternal } from './agent-runs'
import { finalizeAssignmentRun } from './assignments'
import { appendRunEvent } from './run-events'

/**
 * The generic approval executor. Every decided approval is acted on exactly
 * once (claimed via executed_at):
 *
 * - approved → the gated action is carried out with the run's own abilities,
 *   then the agent continues: a suspended run resumes on its stored
 *   transcript; a run that already ended (a call, typically) gets a follow-up
 *   run so the agent can pick the outcome up and close the loop.
 * - declined → no action is performed; the agent is resumed (or followed up)
 *   with the decision so it can adjust and inform whoever is waiting.
 */
export async function decidedApprovalIds(tenantId: string): Promise<string[]> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const rows = await app.db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          or(eq(approvals.status, 'approved'), eq(approvals.status, 'rejected')),
          isNull(approvals.executedAt),
          or(
            eq(approvals.executionStatus, 'pending'),
            eq(approvals.executionStatus, 'failed'),
            and(eq(approvals.executionStatus, 'leased'), lt(approvals.executionLeaseUntil, new Date())),
          ),
        ),
      )
    return rows.map((r) => r.id)
  })
}

export async function executeDecidedApproval(tenantId: string, approvalId: string): Promise<void> {
  const app = db()

  // Lease first, but only stamp executed_at after the complete action +
  // continuation succeeds. A process crash becomes eligible for recovery
  // instead of permanently consuming the approval.
  const claimed = await app.withTenant(tenantId, async () => {
    const now = new Date()
    const leaseUntil = new Date(now.getTime() + 5 * 60_000)
    const [row] = await app.db
      .update(approvals)
      .set({
        executionStatus: 'leased',
        executionLeaseUntil: leaseUntil,
        executionAttempts: sql`${approvals.executionAttempts} + 1`,
        executionError: null,
      })
      .where(
        and(
          eq(approvals.id, approvalId),
          isNull(approvals.executedAt),
          or(eq(approvals.status, 'approved'), eq(approvals.status, 'rejected')),
          or(
            eq(approvals.executionStatus, 'pending'),
            eq(approvals.executionStatus, 'failed'),
            and(eq(approvals.executionStatus, 'leased'), lt(approvals.executionLeaseUntil, now)),
          ),
        ),
      )
      .returning()
    return row ?? null
  })
  if (!claimed) return

  const run = await app.withTenantContext(tenantId, async () => {
    const [row] = await app.db.select().from(runs).where(eq(runs.id, claimed.runId))
    return row ?? null
  })
  if (!run) {
    await markExecutionFailed(tenantId, claimed.id, 'The originating run no longer exists.')
    return
  }

  const action = claimed.payload.action as { toolName?: string; input?: unknown }
  const description = claimed.payload.description

  let result: unknown
  if (claimed.status === 'approved' && action.toolName) {
    result = await app.withTenant(tenantId, async () => {
      const [person] = await app.db.select().from(people).where(eq(people.id, claimed.personId))
      if (!person) return { error: 'Agent not found.' }
      const assembled = await assembleAbilities({
        tenantId,
        person,
        runId: run.id,
        assignmentSource:
          run.trigger.type === 'email' ? { kind: 'mail', threadId: run.trigger.threadId } : { kind: 'manual' },
      })
      const abilities: Ability[] = [...assembled.abilities]
      if (run.trigger.type === 'email') {
        abilities.push(
          replyToThreadAbility({
            tenantId,
            threadId: run.trigger.threadId,
            runId: run.id,
            internal: await threadIsInternal(tenantId, run.trigger.threadId),
          }),
        )
      }
      try {
        const ability = abilities.find((a) => a.name === action.toolName)
        if (!ability?.tool.execute) return { error: `Ability "${action.toolName}" is not available to execute.` }
        return await ability.tool.execute(action.input, { toolCallId: `approval-${claimed.id}`, messages: [] })
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      } finally {
        await assembled.close()
      }
    })
    // The executed action joins the run's append-only record.
    await app.withTenantContext(tenantId, () =>
      appendRunEvent(app.db, {
        tenantId,
        runId: run.id,
        kind: 'tool_result',
        payload: { toolName: action.toolName, output: result, approvedApprovalId: claimed.id },
      }),
    )
  }

  const decisionInput = {
    type: 'approval_decision' as const,
    decision: claimed.status === 'approved' ? ('approved' as const) : ('declined' as const),
    description,
    ...(claimed.status === 'approved' ? { result } : {}),
    ...(claimed.decisionNote ? { note: claimed.decisionNote } : {}),
  }

  const resumable = run.status === 'waiting_approval'
  let continuedRunId: string
  let outcome: Awaited<ReturnType<typeof executeAgentRun>>['outcome']
  try {
    ;({ runId: continuedRunId, outcome } = await executeAgentRun({
      tenantId,
      personId: claimed.personId,
      trigger: resumable ? run.trigger : { type: 'approval_followup', approvalId: claimed.id, originRunId: run.id },
      input: decisionInput,
      ...(resumable ? { resumeRunId: run.id } : {}),
      ...(run.trigger.type === 'assignment' ? { maxSteps: ASSIGNMENT_MAX_STEPS } : {}),
    }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markExecutionFailed(tenantId, claimed.id, message)
    await app.withTenant(tenantId, async () => {
      await app.db
        .update(runs)
        .set({
          status: 'failed',
          finishedAt: new Date(),
          transcript: null,
          summary:
            `The decision on "${description}" was applied, but continuing the run afterwards failed: ${message}`.slice(
              0,
              500,
            ),
        })
        .where(eq(runs.id, run.id))
    })
    throw error
  }

  if (run.trigger.type === 'assignment') {
    await finalizeAssignmentRun(tenantId, run.trigger.assignmentId, continuedRunId, outcome)
  }

  await app.withTenant(tenantId, async () => {
    await app.db
      .update(approvals)
      .set({
        executionStatus: 'succeeded',
        executionLeaseUntil: null,
        executionError: null,
        executedAt: new Date(),
      })
      .where(and(eq(approvals.id, claimed.id), eq(approvals.executionStatus, 'leased')))
  })
}

async function markExecutionFailed(tenantId: string, approvalId: string, message: string): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .update(approvals)
      .set({ executionStatus: 'failed', executionLeaseUntil: null, executionError: message.slice(0, 2_000) })
      .where(eq(approvals.id, approvalId))
  })
}
