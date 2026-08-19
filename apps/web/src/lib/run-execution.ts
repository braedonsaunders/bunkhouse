import 'server-only'
import { and, desc, eq, gt, ne, sql } from 'drizzle-orm'
import type {
  ExecutionLease,
  ExecutionLeaseStore,
  ExternalEffectEvent,
  ExternalEffectIntent,
  ExternalEffectStore,
} from '@braedonsaunders/appkit-events'
import { schema as identity } from '@braedonsaunders/appkit-db'
import {
  approvals,
  externalEffectEvents,
  externalEffectIntents,
  runAttemptEvents,
  runAttempts,
  runs,
} from '../db/schema'
import { db } from '../db/client'
import { assertRunAttemptTransition, type RunAttemptEventKind } from './run-attempt-lifecycle'

const leaseExpiry = (now: Date, leaseMs: number) => new Date(now.getTime() + leaseMs)
const ATTEMPT_TERMINAL_KINDS = new Set<RunAttemptEventKind>(['completed', 'failed', 'cancelled', 'lease_lost'])

async function appendAttemptEvent(args: {
  tenantId: string
  attemptId: string
  kind: (typeof runAttemptEvents.$inferInsert)['kind']
  detail?: Record<string, unknown>
  at?: Date
}): Promise<void> {
  const app = db()
  await app.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('bunkhouse.run_attempt'), hashtext(${args.attemptId}))`)
    const [latest] = await tx
      .select({ seq: runAttemptEvents.seq, kind: runAttemptEvents.kind })
      .from(runAttemptEvents)
      .where(eq(runAttemptEvents.attemptId, args.attemptId))
      .orderBy(desc(runAttemptEvents.seq))
      .limit(1)
    assertRunAttemptTransition(latest?.kind ?? null, args.kind)
    await tx.insert(runAttemptEvents).values({
      tenantId: args.tenantId,
      attemptId: args.attemptId,
      seq: (latest?.seq ?? -1) + 1,
      kind: args.kind,
      detail: args.detail ?? {},
      ...(args.at ? { at: args.at } : {}),
    })
  })
}

export function recordRunAttemptEvent(args: {
  tenantId: string
  attemptId: string
  kind: (typeof runAttemptEvents.$inferInsert)['kind']
  detail?: Record<string, unknown>
}): Promise<void> {
  return appendAttemptEvent(args)
}

/** PostgreSQL-backed lease authority used by AppKit's fenced-run orchestrator. */
export function runExecutionLeaseStore(tenantId: string): ExecutionLeaseStore {
  const app = db()
  return {
    async claim(input) {
      return app.db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(runs)
          .set({
            leaseOwner: input.owner,
            leaseFence: sql`${runs.leaseFence} + 1`,
            leaseExpiresAt: leaseExpiry(input.now, input.leaseMs),
          })
          .where(
            and(
              eq(runs.id, input.runId),
              eq(runs.status, 'running'),
              sql`(${runs.leaseExpiresAt} is null or ${runs.leaseExpiresAt} <= ${input.now})`,
            ),
          )
          // activeAttemptId is intentionally not changed by this statement,
          // so RETURNING gives us the superseded attempt (if a crashed worker
          // left one behind) while the row lock still serializes the takeover.
          .returning({
            fence: runs.leaseFence,
            expiresAt: runs.leaseExpiresAt,
            previousAttemptId: runs.activeAttemptId,
          })
        if (!claimed?.expiresAt) return null
        const [attempt] = await tx
          .insert(runAttempts)
          .values({ tenantId, runId: input.runId, owner: input.owner, fence: claimed.fence })
          .returning({ id: runAttempts.id })
        if (!attempt) throw new Error('The run attempt could not be recorded.')
        if (claimed.previousAttemptId) {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext('bunkhouse.run_attempt'), hashtext(${claimed.previousAttemptId}))`,
          )
          const [latest] = await tx
            .select({ seq: runAttemptEvents.seq, kind: runAttemptEvents.kind })
            .from(runAttemptEvents)
            .where(eq(runAttemptEvents.attemptId, claimed.previousAttemptId))
            .orderBy(desc(runAttemptEvents.seq))
            .limit(1)
          if (!latest || !ATTEMPT_TERMINAL_KINDS.has(latest.kind)) {
            await tx.insert(runAttemptEvents).values({
              tenantId,
              attemptId: claimed.previousAttemptId,
              seq: (latest?.seq ?? -1) + 1,
              kind: 'lease_lost',
              detail: { replacedByAttemptId: attempt.id, replacedByFence: claimed.fence },
              at: input.now,
            })
          }
        }
        await tx.update(runs).set({ activeAttemptId: attempt.id }).where(
          and(eq(runs.id, input.runId), eq(runs.leaseOwner, input.owner), eq(runs.leaseFence, claimed.fence)),
        )
        await tx.insert(runAttemptEvents).values({
          tenantId,
          attemptId: attempt.id,
          seq: 0,
          kind: 'claimed',
          detail: { owner: input.owner, fence: claimed.fence, expiresAt: claimed.expiresAt.toISOString() },
          at: input.now,
        })
        return {
          runId: input.runId,
          attemptId: attempt.id,
          owner: input.owner,
          fence: claimed.fence,
          expiresAt: claimed.expiresAt,
        }
      })
    },
    async renew(lease, input) {
      const expiresAt = leaseExpiry(input.now, input.leaseMs)
      const [renewed] = await app.db
        .update(runs)
        .set({ leaseExpiresAt: expiresAt })
        .where(
          and(
            eq(runs.id, lease.runId),
            eq(runs.status, 'running'),
            eq(runs.leaseOwner, lease.owner),
            eq(runs.leaseFence, lease.fence),
            eq(runs.activeAttemptId, lease.attemptId),
            gt(runs.leaseExpiresAt, input.now),
          ),
        )
        .returning({ id: runs.id })
      if (!renewed) return null
      await appendAttemptEvent({
        tenantId,
        attemptId: lease.attemptId,
        kind: 'renewed',
        detail: { expiresAt: expiresAt.toISOString() },
        at: input.now,
      })
      return { ...lease, expiresAt }
    },
  }
}

/** Fence a mutable run transition against the exact attempt that produced it. */
export function runFence(lease: ExecutionLease) {
  return and(
    eq(runs.id, lease.runId),
    eq(runs.leaseOwner, lease.owner),
    eq(runs.leaseFence, lease.fence),
    eq(runs.activeAttemptId, lease.attemptId),
  )
}

export async function ownsRunAttempt(lease: ExecutionLease): Promise<boolean> {
  const app = db()
  const [row] = await app.db.select({ id: runs.id }).from(runs).where(runFence(lease)).limit(1)
  return Boolean(row)
}

/** Close the lease and append its terminal evidence in one transaction. */
export async function finishRunAttempt(
  tenantId: string,
  lease: ExecutionLease,
  kind: 'completed' | 'failed' | 'cancelled' | 'lease_lost',
  detail: Record<string, unknown> = {},
): Promise<boolean> {
  const app = db()
  return app.db.transaction(async (tx) => {
    const [owned] = await tx
      .update(runs)
      .set({ leaseOwner: null, leaseExpiresAt: null, activeAttemptId: null })
      .where(runFence(lease))
      .returning({ id: runs.id })
    if (!owned) return false
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('bunkhouse.run_attempt'), hashtext(${lease.attemptId}))`,
    )
    const [{ next } = { next: 0 }] = await tx
      .select({ next: sql<number>`coalesce(max(${runAttemptEvents.seq}), -1) + 1`.mapWith(Number) })
      .from(runAttemptEvents)
      .where(eq(runAttemptEvents.attemptId, lease.attemptId))
    await tx.insert(runAttemptEvents).values({
      tenantId,
      attemptId: lease.attemptId,
      seq: next,
      kind,
      detail,
    })
    return true
  })
}

type RunTerminalUpdate = Pick<
  typeof runs.$inferInsert,
  'status' | 'finishedAt' | 'transcript' | 'waiting' | 'summary'
>

/** Commit the terminal run state and its attempt evidence atomically. */
export async function finalizeRunAttempt(
  tenantId: string,
  lease: ExecutionLease,
  update: RunTerminalUpdate,
  kind: 'completed' | 'failed' | 'cancelled',
  detail: Record<string, unknown> = {},
): Promise<boolean> {
  const app = db()
  return app.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(runs)
      .set({ ...update, leaseOwner: null, leaseExpiresAt: null, activeAttemptId: null })
      .where(and(runFence(lease), sql`${runs.status} <> 'cancelled'`))
      .returning({ id: runs.id })

    let terminalKind = kind
    let terminalDetail = detail
    if (!updated) {
      // An operator cancellation that races the worker's terminal commit wins,
      // while the still-owned attempt is closed in the same transaction.
      const [cancelled] = await tx
        .update(runs)
        .set({ leaseOwner: null, leaseExpiresAt: null, activeAttemptId: null })
        .where(and(runFence(lease), eq(runs.status, 'cancelled')))
        .returning({ id: runs.id })
      if (!cancelled) return false
      terminalKind = 'cancelled'
      terminalDetail = { ...detail, outcome: 'cancelled' }
    }

    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('bunkhouse.run_attempt'), hashtext(${lease.attemptId}))`,
    )
    const [{ next } = { next: 0 }] = await tx
      .select({ next: sql<number>`coalesce(max(${runAttemptEvents.seq}), -1) + 1`.mapWith(Number) })
      .from(runAttemptEvents)
      .where(eq(runAttemptEvents.attemptId, lease.attemptId))
    await tx.insert(runAttemptEvents).values({
      tenantId,
      attemptId: lease.attemptId,
      seq: next,
      kind: terminalKind,
      detail: terminalDetail,
    })
    return true
  })
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Resolve the durable key for one governed adapter invocation.
 *
 * A connector-owned domain key is authoritative. Otherwise the first fenced
 * attempt keeps the SDK tool-call id, so two identical calls remain distinct.
 * A later fenced attempt correlates its Nth call of this tool with the Nth
 * immutable intent from the abandoned attempt. A changed request fails closed
 * instead of silently replaying or duplicating a different outside action.
 */
export async function resolveExternalEffectIdempotencyKey(args: {
  tenantId: string
  runId: string
  attemptId: string
  kind: string
  invocationKey: string
  scope: 'invocation' | 'domain'
  request: unknown
  ordinal: number
}): Promise<string> {
  const toolName = args.kind.slice(args.kind.indexOf(':') + 1)
  if (args.scope === 'domain') {
    return `${args.runId}:${toolName}:domain:${args.invocationKey}`
  }

  const recoveryPrefix = `${args.runId}:${toolName}:invocation:${args.ordinal}:`
  const proposed = `${recoveryPrefix}${args.invocationKey}`
  const app = db()
  const prior = await app.db
    .select({ idempotencyKey: externalEffectIntents.idempotencyKey, request: externalEffectIntents.request })
    .from(externalEffectIntents)
    .where(
      and(
        eq(externalEffectIntents.tenantId, args.tenantId),
        eq(externalEffectIntents.runId, args.runId),
        eq(externalEffectIntents.kind, args.kind),
        eq(externalEffectIntents.provenanceKind, 'run_attempt'),
        ne(externalEffectIntents.attemptId, args.attemptId),
      ),
    )

  // The ordinal is part of the immutable key rather than inferred from
  // created_at. Two intents can share a database timestamp, and UUID order is
  // not call order; either would make recovery nondeterministic.
  const recovered = prior.find((intent) => intent.idempotencyKey.startsWith(recoveryPrefix))
  if (recovered && !sameJson(recovered.request, args.request)) {
    throw new Error(
      `Recovered external-effect invocation ${args.ordinal + 1} for ${toolName} does not match its durable intent. Reconcile the prior effect before retrying this run.`,
    )
  }
  if (recovered) return recovered.idempotencyKey

  // Runs fenced before this contract shipped used run + tool + request hash.
  // Never abandon one of those intents during a rolling deployment: that
  // could repeat an effect the old worker already delivered. The old key could
  // not distinguish identical intentional calls, so preserving its one intent
  // is the only fail-safe interpretation available during recovery.
  const toolPrefix = `${args.runId}:${toolName}:`
  const legacy = prior.filter(
    (intent) =>
      intent.idempotencyKey.startsWith(toolPrefix) &&
      !intent.idempotencyKey.startsWith(`${toolPrefix}invocation:`) &&
      !intent.idempotencyKey.startsWith(`${toolPrefix}domain:`) &&
      sameJson(intent.request, args.request),
  )
  if (legacy.length > 1) {
    throw new Error(`More than one legacy external-effect intent matches ${toolName}. Reconcile the prior effects before retrying this run.`)
  }
  return legacy[0]?.idempotencyKey ?? proposed
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function assertEffectTransition(previous: string | null, next: ExternalEffectEvent['kind']): void {
  if (previous === 'completed' || previous === 'reconciled') {
    throw new Error(`External effect is already terminal (${previous}).`)
  }
  if (next === 'retry_started') {
    if (previous !== 'failed' && previous !== 'ambiguous' && previous !== null) {
      throw new Error(`External effect cannot retry after ${previous}.`)
    }
    return
  }
  if (previous !== null && previous !== 'retry_started') {
    throw new Error(`External effect outcome requires a retry boundary after ${previous}.`)
  }
}

/** PostgreSQL implementation of AppKit's immutable intent + outcome protocol. */
export function externalEffectStore<Result = unknown>(tenantId: string): ExternalEffectStore<unknown, Result> {
  const app = db()
  return {
    async claim(intent: ExternalEffectIntent) {
      return app.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(externalEffectIntents)
          .values({
            tenantId,
            runId: intent.runId,
            provenanceKind: intent.kind.startsWith('approval:') ? 'approval' : 'run_attempt',
            attemptId: intent.attemptId,
            kind: intent.kind,
            idempotencyKey: intent.idempotencyKey,
            request: intent.request,
            createdAt: intent.at,
          })
          .onConflictDoNothing({ target: [externalEffectIntents.tenantId, externalEffectIntents.idempotencyKey] })
          .returning({ id: externalEffectIntents.id })
        if (created) return { disposition: 'execute' as const, effectId: created.id, retry: false }

        const [existing] = await tx
          .select()
          .from(externalEffectIntents)
          .where(
            and(
              eq(externalEffectIntents.tenantId, tenantId),
              eq(externalEffectIntents.idempotencyKey, intent.idempotencyKey),
            ),
          )
        if (!existing) throw new Error('The external-effect intent could not be resolved.')
        if (existing.runId !== intent.runId || existing.kind !== intent.kind || !sameJson(existing.request, intent.request)) {
          throw new Error('An idempotency key was reused for a different external effect.')
        }
        const [latest] = await tx
          .select()
          .from(externalEffectEvents)
          .where(eq(externalEffectEvents.effectId, existing.id))
          .orderBy(desc(externalEffectEvents.seq))
          .limit(1)
        if (latest?.kind === 'completed' || latest?.kind === 'reconciled') {
          return {
            disposition: 'completed' as const,
            effectId: existing.id,
            result: latest.payload.result as Result,
          }
        }
        if (latest?.kind === 'failed') {
          return { disposition: 'execute' as const, effectId: existing.id, retry: true }
        }
        return {
          disposition: 'uncertain' as const,
          effectId: existing.id,
          reason: 'A prior attempt may have reached the external system but has no authoritative completion.',
        }
      })
    },
    async append(effectId: string, event: ExternalEffectEvent) {
      await app.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('bunkhouse.external_effect'), hashtext(${effectId}))`)
        const [intent] = await tx
          .select({ id: externalEffectIntents.id })
          .from(externalEffectIntents)
          .where(and(eq(externalEffectIntents.id, effectId), eq(externalEffectIntents.tenantId, tenantId)))
        if (!intent) throw new Error('External-effect intent not found.')
        const [latest] = await tx
          .select({ seq: externalEffectEvents.seq, kind: externalEffectEvents.kind })
          .from(externalEffectEvents)
          .where(eq(externalEffectEvents.effectId, effectId))
          .orderBy(desc(externalEffectEvents.seq))
          .limit(1)
        assertEffectTransition(latest?.kind ?? null, event.kind)
        const { kind, at, ...payload } = event
        await tx.insert(externalEffectEvents).values({
          tenantId,
          effectId,
          seq: (latest?.seq ?? -1) + 1,
          kind,
          payload,
          at,
        })
      })
    },
  }
}

/** Resolve unknown effect fate by appending operator evidence, never editing it. */
export async function reconcileExternalEffect(args: {
  tenantId: string
  effectId: string
  actorUserId: string
  resolution: 'completed' | 'retry'
  note: string
}): Promise<void> {
  const app = db()
  await app.withTenant(args.tenantId, async () => {
    await app.db.execute(
      sql`select pg_advisory_xact_lock(hashtext('bunkhouse.external_effect'), hashtext(${args.effectId}))`,
    )
    const [intent] = await app.db
      .select()
      .from(externalEffectIntents)
      .where(and(eq(externalEffectIntents.id, args.effectId), eq(externalEffectIntents.tenantId, args.tenantId)))
    if (!intent) throw new Error('External effect not found.')
    const [latest] = await app.db
      .select()
      .from(externalEffectEvents)
      .where(eq(externalEffectEvents.effectId, intent.id))
      .orderBy(desc(externalEffectEvents.seq))
      .limit(1)
    if (latest?.kind === 'completed' || latest?.kind === 'reconciled') {
      throw new Error('This external effect already has authoritative completion evidence.')
    }
    // An intent with no outcome is the original in-flight execution, not an
    // invitation to guess. The same is true after retry_started. Wait until
    // its authoritative run/approval lease is gone before accepting operator
    // evidence, otherwise a late adapter completion could race a manual
    // "not completed" decision and make the next retry duplicate the action.
    const now = new Date()
    const [runAuthority] = await app.db
      .select({ status: runs.status, leaseExpiresAt: runs.leaseExpiresAt })
      .from(runs)
      .where(eq(runs.id, intent.runId))
      .limit(1)
    const [approvalAuthority] =
      intent.provenanceKind === 'approval'
        ? await app.db
            .select({ status: approvals.executionStatus, leaseUntil: approvals.executionLeaseUntil })
            .from(approvals)
            .where(eq(approvals.id, intent.attemptId))
            .limit(1)
        : []
    const runOwnsEffect =
      runAuthority?.status === 'running' &&
      runAuthority.leaseExpiresAt !== null &&
      runAuthority.leaseExpiresAt > now
    const approvalOwnsEffect =
      approvalAuthority?.status === 'leased' &&
      approvalAuthority.leaseUntil !== null &&
      approvalAuthority.leaseUntil > now
    if (runOwnsEffect || approvalOwnsEffect) {
      throw new Error('This external effect still has an active execution and cannot be reconciled yet.')
    }
    const detail = {
      actorUserId: args.actorUserId,
      note: args.note,
      resolution: args.resolution === 'completed' ? 'confirmed_completed' : 'confirmed_not_completed',
    }
    await app.db.insert(externalEffectEvents).values({
      tenantId: args.tenantId,
      effectId: intent.id,
      seq: (latest?.seq ?? -1) + 1,
      kind: args.resolution === 'completed' ? 'reconciled' : 'failed',
      payload:
        args.resolution === 'completed'
          ? { result: { reconciled: true }, detail }
          : { error: 'An operator confirmed the effect did not complete and may be retried.', detail },
    })
    await app.db.insert(identity.auditLog).values({
      tenantId: args.tenantId,
      actorUserId: args.actorUserId,
      entityType: 'external_effect',
      entityId: intent.id,
      action: 'external_effect_reconciled',
      summary:
        args.resolution === 'completed'
          ? `${intent.kind} confirmed completed`
          : `${intent.kind} cleared for retry`,
      before: { status: latest?.kind ?? 'intended' },
      after: { status: args.resolution === 'completed' ? 'reconciled' : 'failed' },
      metadata: detail,
    })
  })
}
