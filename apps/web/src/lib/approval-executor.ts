import 'server-only'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import type { Ability } from '@bunkhouse/runtime'
import { approvals, people, runEvents, runs } from '../db/schema'
import { db } from '../db/client'
import { assembleAbilities } from './agent-abilities'
import { ASSIGNMENT_MAX_STEPS, executeAgentRun, replyToThreadAbility } from './agent-runs'
import { finalizeAssignmentRun } from './assignments'

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
      .where(and(or(eq(approvals.status, 'approved'), eq(approvals.status, 'rejected')), isNull(approvals.executedAt)))
    return rows.map((r) => r.id)
  })
}

export async function executeDecidedApproval(tenantId: string, approvalId: string): Promise<void> {
  const app = db()

  // Claim first: whichever job stamps executed_at acts; every other tick skips.
  const claimed = await app.withTenant(tenantId, async () => {
    const [row] = await app.db
      .update(approvals)
      .set({ executedAt: new Date() })
      .where(
        and(
          eq(approvals.id, approvalId),
          isNull(approvals.executedAt),
          or(eq(approvals.status, 'approved'), eq(approvals.status, 'rejected')),
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
  if (!run) return

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
        abilities.push(replyToThreadAbility({ tenantId, threadId: run.trigger.threadId, runId: run.id }))
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
    await app.withTenant(tenantId, async () => {
      const [last] = await app.db
        .select({ seq: sql<number>`coalesce(max(${runEvents.seq}), -1)` })
        .from(runEvents)
        .where(eq(runEvents.runId, run.id))
      await app.db.insert(runEvents).values({
        tenantId,
        runId: run.id,
        seq: (last?.seq ?? -1) + 1,
        kind: 'tool_result',
        payload: { toolName: action.toolName, output: result, approvedApprovalId: claimed.id },
      })
    })
  }

  const decisionInput = {
    type: 'approval_decision' as const,
    decision: claimed.status === 'approved' ? ('approved' as const) : ('declined' as const),
    description,
    ...(claimed.status === 'approved' ? { result } : {}),
    ...(claimed.decisionNote ? { note: claimed.decisionNote } : {}),
  }

  const resumable = run.status === 'waiting_approval'
  const { runId: continuedRunId, outcome } = await executeAgentRun({
    tenantId,
    personId: claimed.personId,
    trigger: resumable ? run.trigger : { type: 'approval_followup', approvalId: claimed.id, originRunId: run.id },
    input: decisionInput,
    ...(resumable ? { resumeRunId: run.id } : {}),
    ...(run.trigger.type === 'assignment' ? { maxSteps: ASSIGNMENT_MAX_STEPS } : {}),
  })

  if (run.trigger.type === 'assignment') {
    await finalizeAssignmentRun(tenantId, run.trigger.assignmentId, continuedRunId, outcome)
  }
}
