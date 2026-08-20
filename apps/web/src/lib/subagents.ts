import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { people, runs, type RunTrigger } from '../db/schema'
import { db } from '../db/client'
import { managerChain } from './org'

/**
 * Work a run launches and collects itself.
 *
 * Two shapes, one machine. A **subagent** runs as the same person on a
 * narrower brief: a way of doing five things at once, inheriting the agent's
 * own dials, abilities and budget, and adding no new actor to the governance
 * model. An **invocation** runs as somebody else — an agent below the caller
 * in the reporting tree — under that person's own governance, which is the
 * whole point of it being a different person rather than a scoped copy.
 *
 * Neither is `delegate_to_colleague`. That hands work away as an assignment
 * and gets an email back hours later, which is right for "please produce this
 * report" and useless for "read these nine filings while I read the tenth".
 * These return to the caller, by handle, and the caller waits.
 *
 * The run row is created BEFORE the job is enqueued, and the brief lives in
 * the trigger rather than the queue message. Both for the same reason: the
 * parent must be able to list what it just launched, and a child whose
 * instruction existed only in Redis would leave a row running forever if the
 * queue dropped it.
 */

/** Children one parent may have in flight. Beyond this the fan-out is a bug. */
export const MAX_CHILDREN_PER_RUN = 12

/**
 * How deep the tree may go. A subagent that can spawn subagents is a recursion
 * with a model in the loop and a credit card attached; the existing handoff
 * guard covers colleague delegation, and this covers the direct path.
 */
export const MAX_CHILD_DEPTH = 3

export type ChildRunView = {
  id: string
  label: string
  kind: 'subagent' | 'invocation'
  /** Who is actually doing it — the caller for a subagent, the report otherwise. */
  personName: string
  status: string
  /** The child's answer, once it has one. */
  summary: string | null
  startedAt: string
  finishedAt: string | null
}

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled'])

export function childIsFinished(status: string): boolean {
  return TERMINAL.has(status)
}

/**
 * May `callerId` invoke `targetId` directly?
 *
 * Only downward, and transitively: a director may invoke anyone beneath them,
 * not merely their direct reports. Sideways and upward are refused — a peer is
 * emailed and a manager is escalated to, and letting an agent start work on
 * someone senior to it inverts the reporting line the rest of the app reads as
 * authority.
 */
export function canInvoke(
  roster: Array<{ id: string; name: string; reportsToId: string | null }>,
  callerId: string,
  targetId: string,
): boolean {
  if (callerId === targetId) return false
  return managerChain(roster, targetId).some((manager) => manager.id === callerId)
}

/** The roster this tenant's org questions are answered against. */
export async function orgRoster(
  tenantId: string,
): Promise<Array<{ id: string; name: string; reportsToId: string | null; kind: string; email: string | null }>> {
  const app = db()
  return app.withTenantContext(tenantId, () =>
    app.db
      .select({
        id: people.id,
        name: people.name,
        reportsToId: people.reportsToId,
        kind: people.kind,
        email: people.email,
      })
      .from(people))
}

/**
 * Create the child's run row and hand back its id.
 *
 * Does not execute anything: the caller enqueues the returned id, and the
 * worker picks it up. `status` starts as `running` because from the parent's
 * point of view it is — there is no queued state in the run status enum, and
 * inventing one would mean every existing surface that reads run status had to
 * learn about it.
 */
export async function createChildRun(args: {
  tenantId: string
  /** Who will do the work: the caller for a subagent, the report for an invocation. */
  personId: string
  parentRunId: string
  rootRunId: string | null
  label: string
  brief: string
  kind: 'subagent' | 'invocation'
  /** Who launched it. Only meaningful — and only recorded — for an invocation. */
  byPersonId: string
}): Promise<string> {
  const app = db()
  const trigger: RunTrigger = args.kind === 'subagent'
    ? { type: 'subagent', parentRunId: args.parentRunId, label: args.label, brief: args.brief }
    : {
        type: 'invocation',
        parentRunId: args.parentRunId,
        label: args.label,
        brief: args.brief,
        byPersonId: args.byPersonId,
      }
  return app.withTenant(args.tenantId, async () => {
    const [row] = await app.db
      .insert(runs)
      .values({
        tenantId: args.tenantId,
        personId: args.personId,
        trigger,
        status: 'running',
        ...(args.rootRunId ? { rootRunId: args.rootRunId } : {}),
      })
      .returning({ id: runs.id })
    return row!.id
  })
}

/** Everything one run launched, in the order it launched them. */
export async function childrenOf(tenantId: string, parentRunId: string): Promise<ChildRunView[]> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const rows = await app.db
      .select({
        id: runs.id,
        trigger: runs.trigger,
        status: runs.status,
        summary: runs.summary,
        personId: runs.personId,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
      })
      .from(runs)
      .where(and(
        inArray(sql`${runs.trigger} ->> 'type'`, ['subagent', 'invocation']),
        eq(sql`${runs.trigger} ->> 'parentRunId'`, parentRunId),
      ))
      .orderBy(runs.startedAt)
    if (rows.length === 0) return []

    const names = new Map(
      (await app.db
        .select({ id: people.id, name: people.name })
        .from(people)
        .where(inArray(people.id, [...new Set(rows.map((row) => row.personId))])))
        .map((row) => [row.id, row.name]),
    )

    return rows.map((row) => {
      const trigger = row.trigger as { type: string; label?: string }
      return {
        id: row.id,
        label: typeof trigger.label === 'string' ? trigger.label : 'work',
        kind: trigger.type === 'invocation' ? ('invocation' as const) : ('subagent' as const),
        personName: names.get(row.personId) ?? 'someone',
        status: row.status,
        summary: row.summary,
        startedAt: row.startedAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
      }
    })
  })
}

/**
 * Children that exist but have never been picked up.
 *
 * `active_attempt_id IS NULL` is what "never started" means here: an attempt is
 * leased the moment a worker begins, so a running row without one was created
 * by the ability and abandoned — either still waiting for its first tick, or
 * orphaned by a worker that died before it claimed anything. Re-enqueueing both
 * is correct, and the queue's jobId keeps it idempotent.
 */
export async function unstartedChildRunIds(tenantId: string): Promise<string[]> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const rows = await app.db
      .select({ id: runs.id })
      .from(runs)
      .where(and(
        inArray(sql`${runs.trigger} ->> 'type'`, ['subagent', 'invocation']),
        eq(runs.status, 'running'),
        sql`${runs.activeAttemptId} is null`,
      ))
    return rows.map((row) => row.id)
  })
}

/**
 * Execute one launched child.
 *
 * The row already exists, so this adopts it via `resumeRunId` rather than
 * creating a second one — the parent has been able to see and name this child
 * since the moment it was launched, and a fresh row here would orphan that.
 */
export async function runLaunchedChild(tenantId: string, runId: string): Promise<void> {
  const app = db()
  const found = await app.withTenantContext(tenantId, async () => {
    const [row] = await app.db
      .select({ trigger: runs.trigger, personId: runs.personId, status: runs.status, attempt: runs.activeAttemptId })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
    return row ?? null
  })
  if (!found) return
  // Another worker got there first; the queue's jobId makes this rare and the
  // check makes it harmless.
  if (found.attempt !== null || found.status !== 'running') return
  const trigger = found.trigger
  if (trigger.type !== 'subagent' && trigger.type !== 'invocation') return

  const { executeAgentRun } = await import('./agent-runs')
  await executeAgentRun({
    tenantId,
    personId: found.personId,
    trigger,
    input: { type: 'duty', dutyTitle: trigger.label, instruction: trigger.brief },
    resumeRunId: runId,
  })
}

/**
 * How deep in a chain of launched work this run already sits.
 *
 * Walks parent links rather than trusting a counter passed down, because a
 * counter is only as honest as every hop that forwarded it, and this one
 * bounds spend.
 */
export async function childDepth(tenantId: string, runId: string): Promise<number> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    let depth = 0
    let current: string | null = runId
    const seen = new Set<string>()
    while (current && !seen.has(current) && depth <= MAX_CHILD_DEPTH + 1) {
      seen.add(current)
      const [row]: Array<{ trigger: unknown }> = await app.db
        .select({ trigger: runs.trigger })
        .from(runs)
        .where(eq(runs.id, current))
        .limit(1)
      const trigger = row?.trigger as { type?: string; parentRunId?: string } | undefined
      if (!trigger || (trigger.type !== 'subagent' && trigger.type !== 'invocation')) break
      depth += 1
      current = trigger.parentRunId ?? null
    }
    return depth
  })
}
