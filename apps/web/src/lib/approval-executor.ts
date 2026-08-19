import 'server-only'
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { redactSecretValue, takeAbilityFrame, type Ability } from '@bunkhouse/runtime'
import { executeExternalEffect } from '@braedonsaunders/appkit-events'
import { approvals, people, runs } from '../db/schema'
import { db } from '../db/client'
import { assembleAbilities } from './agent-abilities'
import { ASSIGNMENT_MAX_STEPS, executeAgentRun, replyToThreadAbility, threadIsInternal } from './agent-runs'
import { finalizeAssignmentRun } from './assignments'
import { planApprovalExecution, settlementAfterFailure } from './approval-execution'
import { appendRunEvent } from './run-events'
import { externalEffectStore } from './run-execution'

/**
 * The generic approval executor. Every decided approval is acted on exactly
 * once (claimed via executed_at):
 *
 * - approved → the gated action is carried out with the run's own abilities,
 *   then the agent continues: a suspended run resumes on its stored
 *   transcript; a run that already ended (a call, typically) gets a follow-up
 *   run so the agent can pick the outcome up and close the loop.
 * - declined → no action is performed. A run still parked on the decision is
 *   resumed with it so the agent can adjust; a run that has already been closed
 *   is told on its own ledger and the approval finishes. Delivering a refusal
 *   is never a reason to start fresh work.
 */

/** How long one attempt may hold the row before another worker may retry it. */
const EXECUTION_LEASE_MS = 5 * 60_000

/**
 * TERMINAL vs RETRYABLE — see `settlementAfterFailure` in lib/approval-execution.
 * Every ending in this file goes through one of these two rather than writing
 * the columns by hand, because only one of them actually stops the retry.
 */
async function settleTerminal(tenantId: string, approvalId: string, error: string | null): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .update(approvals)
      .set({
        executionStatus: error === null ? 'succeeded' : 'failed',
        executionLeaseUntil: null,
        executionError: error === null ? null : error.slice(0, 2_000),
        // The stamp is the terminal state. Without it, 'failed' comes straight
        // back round on the next pass.
        executedAt: new Date(),
      })
      // A success is authoritative and always writes. A failure does not
      // overwrite one: two attempts can overlap when a lease expires mid-run,
      // and the straggler's error must not bury the outcome that worked.
      .where(error === null ? eq(approvals.id, approvalId) : and(eq(approvals.id, approvalId), isNull(approvals.executedAt)))
  })
}

/** Leave the row eligible for another attempt — bounded by the cap above. */
async function settleRetryable(tenantId: string, approvalId: string, error: string): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .update(approvals)
      .set({ executionStatus: 'failed', executionLeaseUntil: null, executionError: error.slice(0, 2_000) })
      .where(eq(approvals.id, approvalId))
  })
}

export async function decidedApprovalIds(tenantId: string): Promise<string[]> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const rows = await app.db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          // Both decisions, on purpose: an agent has to be told its request was
          // refused, not merely left waiting.
          or(eq(approvals.status, 'approved'), eq(approvals.status, 'rejected')),
          // The one terminal condition. See settleTerminal above: 'failed' is
          // in the retry set two lines down, so nothing else stops this.
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
    const leaseUntil = new Date(now.getTime() + EXECUTION_LEASE_MS)
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

  // EVERYTHING between the claim and the stamp is guarded. It used not to be:
  // only the continuation call was, so a failure anywhere else — settling the
  // assignment, appending the ledger, the worker being killed while the model
  // was still thinking — left the row 'leased' with no error recorded at all,
  // which is exactly the state the runaway was found in. An attempt that ends
  // any other way than this try/catch is not possible.
  try {
    await carryOutDecision(tenantId, claimed)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const settlement = settlementAfterFailure(claimed.executionAttempts, message)
    if (settlement.terminal) await settleTerminal(tenantId, claimed.id, settlement.error)
    else await settleRetryable(tenantId, claimed.id, settlement.error)
    throw error
  }
}

type ClaimedApproval = typeof approvals.$inferSelect

async function carryOutDecision(tenantId: string, claimed: ClaimedApproval): Promise<void> {
  const app = db()

  const context = await app.withTenantContext(tenantId, async () => {
    const [run] = await app.db.select().from(runs).where(eq(runs.id, claimed.runId))
    const [person] = await app.db.select().from(people).where(eq(people.id, claimed.personId))
    return { run: run ?? null, person: person ?? null }
  })

  const decision = claimed.status === 'approved' ? ('approved' as const) : ('rejected' as const)
  const plan = planApprovalExecution({
    attempts: claimed.executionAttempts,
    decision,
    run: context.run,
    person: context.person,
  })

  if (plan.do === 'give_up') {
    await settleTerminal(tenantId, claimed.id, plan.reason)
    return
  }

  const run = context.run!
  const description = claimed.payload.description
  const declined = `The decision on "${description}" was to decline it${claimed.decisionNote ? `, with this note: ${claimed.decisionNote}` : '.'}`

  if (plan.do === 'deliver_refusal') {
    // The refusal goes on the run's own append-only record — the same place the
    // request went — and nothing is started to deliver it.
    await app.withTenantContext(tenantId, () =>
      appendRunEvent(app.db, {
        tenantId,
        runId: run.id,
        kind: 'message',
        payload: { text: `${declined} No action was taken, and the run had already closed.` },
      }),
    )
    // A deliverable that was blocked on this decision is settled too, rather
    // than left sitting at 'waiting_approval' for an answer that has arrived.
    if (run.trigger.type === 'assignment') {
      await finalizeAssignmentRun(tenantId, run.trigger.assignmentId, run.id, {
        status: 'failed',
        error: declined,
        usage: { inputTokens: 0, outputTokens: 0 },
        messages: [],
      })
    }
    await settleTerminal(tenantId, claimed.id, null)
    return
  }

  const action = claimed.payload.action as { toolName?: string; input?: unknown }
  let result: unknown
  if (decision === 'approved' && action.toolName) {
    result = await app.withTenant(tenantId, async () => {
      const person = context.person!
      const assembled = await assembleAbilities({
        tenantId,
        person,
        runId: run.id,
        allowStandingSchedules:
          run.trigger.type === 'chat' ||
          (run.trigger.type === 'manual' && Boolean(run.trigger.requestedBy)) ||
          (run.trigger.type === 'email' && (await threadIsInternal(tenantId, run.trigger.threadId))),
        assignmentSource:
          run.trigger.type === 'email' ? { kind: 'mail', threadId: run.trigger.threadId } : { kind: 'manual' },
        ...(run.trigger.type === 'chat' && run.trigger.conversationId.startsWith('web:')
          ? { chatThreadId: run.trigger.conversationId.slice('web:'.length) }
          : {}),
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
        const execute = ability.tool.execute.bind(ability.tool)
        return await executeExternalEffect({
          store: externalEffectStore(tenantId),
          intent: {
            tenantId,
            runId: run.id,
            // Approval execution has its own durable lease/attempt identity.
            // It is a UUID and deliberately occupies this provenance slot
            // without pretending the resumed model attempt performed it.
            attemptId: claimed.id,
            kind: `approval:${action.toolName}`,
            idempotencyKey: `approval:${claimed.id}:${action.toolName}`,
            request: { approvalId: claimed.id, toolName: action.toolName, input: action.input },
          },
          sanitize: (value) => {
            const { rest } = takeAbilityFrame(value)
            return redactSecretValue(rest, assembled.secrets)
          },
          classifyError: () => 'ambiguous',
          execute: (signal) =>
            Promise.resolve(
              execute(action.input, {
                toolCallId: `approval-${claimed.id}`,
                messages: [],
                abortSignal: signal,
              }),
            ),
        })
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
    decision: decision === 'approved' ? ('approved' as const) : ('declined' as const),
    description,
    ...(decision === 'approved' ? { result } : {}),
    ...(claimed.decisionNote ? { note: claimed.decisionNote } : {}),
  }

  let continuedRunId: string
  let outcome: Awaited<ReturnType<typeof executeAgentRun>>['outcome']
  try {
    ;({ runId: continuedRunId, outcome } = await executeAgentRun({
      tenantId,
      personId: claimed.personId,
      trigger: plan.resume ? run.trigger : { type: 'approval_followup', approvalId: claimed.id, originRunId: run.id },
      input: decisionInput,
      ...(plan.resume ? { resumeRunId: run.id } : {}),
      ...(run.trigger.type === 'assignment' ? { maxSteps: ASSIGNMENT_MAX_STEPS } : {}),
    }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // The run says what happened to it; the approval's own settlement is the
    // caller's, so this only records the run and re-throws.
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

  await settleTerminal(tenantId, claimed.id, null)
}
