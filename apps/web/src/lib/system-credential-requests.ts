import 'server-only'

import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm'
import {
  authoredSystemCredentialRequestEvents,
  authoredSystemCredentialRequests,
  authoredSystemRevisions,
  authoredSystems,
  chatMessages,
  chatThreads,
  runs,
} from '../db/schema'
import { db } from '../db/client'
import { activateAuthoredSystem, listAuthoredSystems } from './authored-systems'
import { redactCredentialText } from './credential-redaction'

const REQUEST_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000
const VERIFYING_LEASE_MS = 2 * 60 * 1_000
const CONTINUATION_LEASE_MS = 10 * 60 * 1_000
const CONTINUATION_MAX_ATTEMPTS = 5

type RequestRow = typeof authoredSystemCredentialRequests.$inferSelect
type RequestEventKind = typeof authoredSystemCredentialRequestEvents.$inferInsert.kind

export type SystemCredentialRequestView = {
  id: string
  threadId: string
  runId: string
  systemId: string
  systemName: string
  systemSlug: string
  revisionVersion: number
  credentialLabel: string
  purpose: string
  helpUrl: string | null
  authKind: 'bearer' | 'header' | 'query'
  operations: Array<{ name: string; title: string; category: string }>
  status: 'pending' | 'verifying' | 'stored' | 'cancelled' | 'expired'
  attempts: number
  lastError: string | null
  createdAt: string
  expiresAt: string
  resolvedAt: string | null
  continuationPending: boolean
}

function cleanText(value: string, label: string, max: number): string {
  const clean = value.trim()
  if (!clean) throw new Error(`${label} is required.`)
  if (clean.length > max) throw new Error(`${label} must be ${max} characters or fewer.`)
  return clean
}

function cleanHelpUrl(value: string | undefined): string | null {
  const clean = value?.trim()
  if (!clean) return null
  let parsed: URL
  try {
    parsed = new URL(clean)
  } catch {
    throw new Error('The credential help link must be a valid HTTPS URL.')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('The credential help link must be a valid HTTPS URL.')
  }
  return parsed.toString()
}

function publicStatus(request: RequestRow): SystemCredentialRequestView['status'] {
  if ((request.status === 'pending' || request.status === 'verifying') && request.expiresAt <= new Date()) {
    return 'expired'
  }
  return request.status
}

async function appendRequestEvent(
  tx: Parameters<Parameters<ReturnType<typeof db>['db']['transaction']>[0]>[0],
  args: {
    tenantId: string
    requestId: string
    kind: RequestEventKind
    actorType: 'agent' | 'user' | 'system'
    actorId?: string
    detail?: Record<string, unknown>
  },
): Promise<void> {
  const [{ nextSeq }] = await tx
    .select({ nextSeq: sql<number>`coalesce(max(${authoredSystemCredentialRequestEvents.seq}), 0) + 1` })
    .from(authoredSystemCredentialRequestEvents)
    .where(eq(authoredSystemCredentialRequestEvents.requestId, args.requestId))
  await tx.insert(authoredSystemCredentialRequestEvents).values({
    tenantId: args.tenantId,
    requestId: args.requestId,
    seq: Number(nextSeq),
    kind: args.kind,
    actorType: args.actorType,
    actorId: args.actorId ?? null,
    detail: args.detail ?? {},
  })
}

/**
 * Persist the inline ask after an employee has proposed a system. Only display
 * metadata is accepted here. A credential is never an ability input.
 */
export async function requestSystemCredential(args: {
  tenantId: string
  threadId: string
  personId: string
  runId: string
  systemSlug: string
  credentialLabel: string
  purpose: string
  helpUrl?: string
}): Promise<{ id: string; status: 'pending'; systemName: string }> {
  const credentialLabel = cleanText(args.credentialLabel, 'Credential label', 120)
  const purpose = cleanText(args.purpose, 'Purpose', 500)
  const helpUrl = cleanHelpUrl(args.helpUrl)
  const systemSlug = cleanText(args.systemSlug, 'System slug', 64).toLowerCase()
  const app = db()
  return app.withTenant(args.tenantId, () => app.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${args.tenantId}:${args.threadId}:${systemSlug}`}, 0))`)
    const [thread] = await tx
      .select()
      .from(chatThreads)
      .where(and(eq(chatThreads.tenantId, args.tenantId), eq(chatThreads.id, args.threadId)))
      .limit(1)
    if (!thread || thread.personId !== args.personId) {
      throw new Error('This credential request is not anchored to the employee’s conversation.')
    }
    if (thread.status !== 'open') throw new Error('That conversation is archived.')

    const [system] = await tx
      .select()
      .from(authoredSystems)
      .where(and(eq(authoredSystems.tenantId, args.tenantId), eq(authoredSystems.slug, systemSlug)))
      .limit(1)
    if (!system || system.proposedByPersonId !== args.personId || system.proposedByRunId !== args.runId) {
      throw new Error('Request a credential only for the system proposal created in this run.')
    }
    const [revision] = await tx
      .select()
      .from(authoredSystemRevisions)
      .where(and(
        eq(authoredSystemRevisions.systemId, system.id),
        eq(authoredSystemRevisions.version, system.latestVersion),
      ))
      .limit(1)
    if (!revision) throw new Error('The proposed system revision is missing.')
    if (revision.definition.auth.kind === 'none') {
      throw new Error('This system does not require a credential.')
    }

    const [existing] = await tx
      .select()
      .from(authoredSystemCredentialRequests)
      .where(and(
        eq(authoredSystemCredentialRequests.threadId, args.threadId),
        eq(authoredSystemCredentialRequests.systemId, system.id),
        sql`${authoredSystemCredentialRequests.status} in ('pending', 'verifying')`,
      ))
      .limit(1)
    if (existing && existing.revisionVersion === revision.version && existing.expiresAt > new Date()) {
      return { id: existing.id, status: 'pending' as const, systemName: system.name }
    }
    if (existing) {
      await tx
        .update(authoredSystemCredentialRequests)
        .set({ status: 'expired', resolvedAt: new Date(), updatedAt: new Date() })
        .where(eq(authoredSystemCredentialRequests.id, existing.id))
      await appendRequestEvent(tx, {
        tenantId: args.tenantId,
        requestId: existing.id,
        kind: 'expired',
        actorType: 'system',
        detail: { reason: existing.revisionVersion === revision.version ? 'time_limit' : 'superseded_revision' },
      })
    }

    const [request] = await tx
      .insert(authoredSystemCredentialRequests)
      .values({
        tenantId: args.tenantId,
        threadId: args.threadId,
        personId: args.personId,
        runId: args.runId,
        systemId: system.id,
        revisionVersion: revision.version,
        credentialLabel,
        purpose,
        helpUrl,
        expiresAt: new Date(Date.now() + REQUEST_LIFETIME_MS),
      })
      .returning()
    if (!request) throw new Error('The secure credential request could not be saved.')
    await appendRequestEvent(tx, {
      tenantId: args.tenantId,
      requestId: request.id,
      kind: 'requested',
      actorType: 'agent',
      actorId: args.personId,
      detail: { systemId: system.id, revisionVersion: revision.version },
    })
    return { id: request.id, status: 'pending' as const, systemName: system.name }
  }))
}

/** Read-only projection for the conversation. It derives executable scope from the pinned revision. */
export async function listThreadSystemCredentialRequests(
  tenantId: string,
  threadId: string,
): Promise<SystemCredentialRequestView[]> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const rows = await app.db
      .select({ request: authoredSystemCredentialRequests, system: authoredSystems, revision: authoredSystemRevisions })
      .from(authoredSystemCredentialRequests)
      .innerJoin(authoredSystems, eq(authoredSystems.id, authoredSystemCredentialRequests.systemId))
      .innerJoin(authoredSystemRevisions, and(
        eq(authoredSystemRevisions.systemId, authoredSystemCredentialRequests.systemId),
        eq(authoredSystemRevisions.version, authoredSystemCredentialRequests.revisionVersion),
      ))
      .where(eq(authoredSystemCredentialRequests.threadId, threadId))
      .orderBy(asc(authoredSystemCredentialRequests.createdAt))
    return rows.flatMap(({ request, system, revision }) => {
      if (revision.definition.auth.kind === 'none') return []
      return [{
        id: request.id,
        threadId: request.threadId,
        runId: request.runId,
        systemId: system.id,
        systemName: system.name,
        systemSlug: system.slug,
        revisionVersion: request.revisionVersion,
        credentialLabel: request.credentialLabel,
        purpose: request.purpose,
        helpUrl: request.helpUrl,
        authKind: revision.definition.auth.kind,
        operations: revision.definition.operations.map((operation) => ({
          name: operation.name,
          title: operation.title,
          category: operation.category,
        })),
        status: publicStatus(request),
        attempts: request.attempts,
        lastError: request.lastError,
        createdAt: request.createdAt.toISOString(),
        expiresAt: request.expiresAt.toISOString(),
        resolvedAt: request.resolvedAt?.toISOString() ?? null,
        continuationPending: request.status === 'stored' && request.continuedAt === null,
      }]
    })
  })
}

async function claimRequest(args: {
  tenantId: string
  requestId: string
  threadId: string
  userId: string
}): Promise<RequestRow> {
  const app = db()
  return app.withTenant(args.tenantId, () => app.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${args.tenantId}:${args.requestId}`}, 0))`)
    const [request] = await tx
      .select()
      .from(authoredSystemCredentialRequests)
      .where(and(
        eq(authoredSystemCredentialRequests.tenantId, args.tenantId),
        eq(authoredSystemCredentialRequests.id, args.requestId),
        eq(authoredSystemCredentialRequests.threadId, args.threadId),
      ))
      .limit(1)
    if (!request) throw new Error('That credential request no longer exists.')
    if (request.status === 'stored') return request
    if (request.status === 'cancelled' || request.status === 'expired') {
      throw new Error('That credential request is no longer open.')
    }
    const now = new Date()
    if (request.expiresAt <= now) {
      await tx.update(authoredSystemCredentialRequests).set({
        status: 'expired',
        resolvedAt: now,
        resolvedBy: args.userId,
        updatedAt: now,
        updatedBy: args.userId,
      }).where(eq(authoredSystemCredentialRequests.id, request.id))
      await appendRequestEvent(tx, {
        tenantId: args.tenantId,
        requestId: request.id,
        kind: 'expired',
        actorType: 'system',
        detail: { reason: 'time_limit' },
      })
      throw new Error('That credential request has expired. Ask the employee to request it again.')
    }
    if (request.status === 'verifying') {
      const staleBefore = new Date(now.getTime() - VERIFYING_LEASE_MS)
      if (request.verificationStartedAt && request.verificationStartedAt > staleBefore) {
        throw new Error('This credential is already being verified.')
      }
      const recoveryError = 'A previous verification did not finish. Retrying safely.'
      await tx.update(authoredSystemCredentialRequests).set({
        status: 'pending',
        lastError: recoveryError,
        verificationStartedAt: null,
        updatedAt: now,
      }).where(eq(authoredSystemCredentialRequests.id, request.id))
      await appendRequestEvent(tx, {
        tenantId: args.tenantId,
        requestId: request.id,
        kind: 'verification_failed',
        actorType: 'system',
        detail: { reason: 'lease_recovered' },
      })
    }
    const [claimed] = await tx.update(authoredSystemCredentialRequests).set({
      status: 'verifying',
      attempts: request.attempts + 1,
      lastError: null,
      verificationStartedAt: now,
      updatedAt: now,
      updatedBy: args.userId,
    }).where(eq(authoredSystemCredentialRequests.id, request.id)).returning()
    if (!claimed) throw new Error('That credential request could not be claimed.')
    await appendRequestEvent(tx, {
      tenantId: args.tenantId,
      requestId: request.id,
      kind: 'verification_started',
      actorType: 'user',
      actorId: args.userId,
      detail: { attempt: claimed.attempts },
    })
    return claimed
  }))
}

async function finishRequest(args: {
  tenantId: string
  requestId: string
  userId: string
  result: { kind: 'stored'; toolCount: number } | { kind: 'failed'; message: string }
}): Promise<void> {
  const app = db()
  await app.withTenant(args.tenantId, () => app.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${args.tenantId}:${args.requestId}`}, 0))`)
    const [request] = await tx
      .select()
      .from(authoredSystemCredentialRequests)
      .where(eq(authoredSystemCredentialRequests.id, args.requestId))
      .limit(1)
    if (!request) throw new Error('That credential request no longer exists.')
    if (request.status !== 'verifying') {
      if (request.status === 'stored' && args.result.kind === 'stored') return
      throw new Error(`Credential request completion found unexpected status ${request.status}.`)
    }
    const now = new Date()
    if (args.result.kind === 'stored') {
      await tx.update(authoredSystemCredentialRequests).set({
        status: 'stored',
        lastError: null,
        resolvedAt: now,
        resolvedBy: args.userId,
        updatedAt: now,
        updatedBy: args.userId,
      }).where(eq(authoredSystemCredentialRequests.id, request.id))
      await appendRequestEvent(tx, {
        tenantId: args.tenantId,
        requestId: request.id,
        kind: 'stored',
        actorType: 'user',
        actorId: args.userId,
        detail: { toolCount: args.result.toolCount },
      })
      return
    }
    await tx.update(authoredSystemCredentialRequests).set({
      status: 'pending',
      lastError: args.result.message,
      verificationStartedAt: null,
      updatedAt: now,
      updatedBy: args.userId,
    }).where(eq(authoredSystemCredentialRequests.id, request.id))
    await appendRequestEvent(tx, {
      tenantId: args.tenantId,
      requestId: request.id,
      kind: 'verification_failed',
      actorType: 'user',
      actorId: args.userId,
      detail: { message: args.result.message },
    })
  }))
}

/**
 * Verify and seal a submitted value. The return object, request ledger and
 * audit log contain only status/error metadata; the plaintext dies with this
 * server invocation.
 */
export async function submitSystemCredentialRequest(args: {
  tenantId: string
  threadId: string
  requestId: string
  userId: string
  credential: string
}): Promise<{ ok: true; toolCount: number } | { ok: false; message: string }> {
  const credential = args.credential.trim()
  if (!credential) return { ok: false, message: 'Enter the requested credential.' }
  const request = await claimRequest(args)
  if (request.status === 'stored') return { ok: true, toolCount: 0 }
  try {
    const records = await listAuthoredSystems(args.tenantId)
    const record = records.find((candidate) => candidate.system.id === request.systemId)
    if (!record || record.system.latestVersion !== request.revisionVersion) {
      throw new Error('This proposal changed after the credential was requested. Review the new version first.')
    }
    const activated = await activateAuthoredSystem({
      tenantId: args.tenantId,
      systemId: request.systemId,
      actorUserId: args.userId,
      credential,
      assignment: { personIds: [request.personId] },
    })
    await finishRequest({
      tenantId: args.tenantId,
      requestId: request.id,
      userId: args.userId,
      result: { kind: 'stored', toolCount: activated.toolCount },
    })
    return { ok: true, toolCount: activated.toolCount }
  } catch (reason) {
    const raw = reason instanceof Error ? reason.message : String(reason)
    const message = redactCredentialText(raw, credential).slice(0, 2_000)
    await finishRequest({
      tenantId: args.tenantId,
      requestId: request.id,
      userId: args.userId,
      result: { kind: 'failed', message },
    })
    return { ok: false, message }
  }
}

/** Stored handoffs that still owe their conversation a continued answer. */
export async function pendingStoredCredentialContinuationIds(tenantId: string): Promise<string[]> {
  const app = db()
  const now = new Date()
  return app.withTenantContext(tenantId, async () => {
    const rows = await app.db
      .select({ id: authoredSystemCredentialRequests.id })
      .from(authoredSystemCredentialRequests)
      .where(and(
        eq(authoredSystemCredentialRequests.status, 'stored'),
        isNull(authoredSystemCredentialRequests.continuedAt),
        lt(authoredSystemCredentialRequests.continuationAttempts, CONTINUATION_MAX_ATTEMPTS),
        or(
          eq(authoredSystemCredentialRequests.continuationStatus, 'pending'),
          eq(authoredSystemCredentialRequests.continuationStatus, 'failed'),
          and(
            eq(authoredSystemCredentialRequests.continuationStatus, 'leased'),
            lt(authoredSystemCredentialRequests.continuationLeaseUntil, now),
          ),
        ),
      ))
    return rows.map((row) => row.id)
  })
}

async function claimStoredCredentialContinuation(tenantId: string, requestId: string): Promise<RequestRow | null> {
  const app = db()
  const now = new Date()
  const leaseUntil = new Date(now.getTime() + CONTINUATION_LEASE_MS)
  return app.withTenant(tenantId, async () => {
    const [row] = await app.db
      .update(authoredSystemCredentialRequests)
      .set({
        continuationStatus: 'leased',
        continuationLeaseUntil: leaseUntil,
        continuationAttempts: sql`${authoredSystemCredentialRequests.continuationAttempts} + 1`,
        continuationError: null,
        updatedAt: now,
      })
      .where(and(
        eq(authoredSystemCredentialRequests.id, requestId),
        eq(authoredSystemCredentialRequests.status, 'stored'),
        isNull(authoredSystemCredentialRequests.continuedAt),
        lt(authoredSystemCredentialRequests.continuationAttempts, CONTINUATION_MAX_ATTEMPTS),
        or(
          eq(authoredSystemCredentialRequests.continuationStatus, 'pending'),
          eq(authoredSystemCredentialRequests.continuationStatus, 'failed'),
          and(
            eq(authoredSystemCredentialRequests.continuationStatus, 'leased'),
            lt(authoredSystemCredentialRequests.continuationLeaseUntil, now),
          ),
        ),
      ))
      .returning()
    return row ?? null
  })
}

async function settleStoredCredentialContinuation(args: {
  tenantId: string
  requestId: string
  runId?: string
  error?: string
}): Promise<void> {
  const app = db()
  await app.withTenant(args.tenantId, async () => {
    const [request] = await app.db
      .select({ attempts: authoredSystemCredentialRequests.continuationAttempts })
      .from(authoredSystemCredentialRequests)
      .where(eq(authoredSystemCredentialRequests.id, args.requestId))
      .limit(1)
    const terminal = Boolean(args.runId) || (request?.attempts ?? CONTINUATION_MAX_ATTEMPTS) >= CONTINUATION_MAX_ATTEMPTS
    await app.db
      .update(authoredSystemCredentialRequests)
      .set({
        continuationStatus: args.runId ? 'succeeded' : 'failed',
        continuationLeaseUntil: null,
        continuationError: args.error?.slice(0, 2_000) ?? null,
        ...(args.runId ? { continuedRunId: args.runId } : {}),
        ...(terminal ? { continuedAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(and(
        eq(authoredSystemCredentialRequests.id, args.requestId),
        eq(authoredSystemCredentialRequests.continuationStatus, 'leased'),
      ))
  })
}

/**
 * Wake the exact work that opened a sealed handoff. New runs are genuinely
 * parked and resume their transcript; requests created before that lifecycle
 * existed receive one provenance-linked follow-up run with bounded chat
 * context. The request row is a recoverable lease, so a web process dying
 * after storage cannot turn “continue automatically” into an empty promise.
 */
export async function executeStoredCredentialContinuation(tenantId: string, requestId: string): Promise<void> {
  const request = await claimStoredCredentialContinuation(tenantId, requestId)
  if (!request) return
  try {
    const app = db()
    const context = await app.withTenantContext(tenantId, async () => {
      const [[origin], [system], [revision], messages] = await Promise.all([
        app.db.select().from(runs).where(eq(runs.id, request.runId)).limit(1),
        app.db.select().from(authoredSystems).where(eq(authoredSystems.id, request.systemId)).limit(1),
        app.db
          .select()
          .from(authoredSystemRevisions)
          .where(and(
            eq(authoredSystemRevisions.systemId, request.systemId),
            eq(authoredSystemRevisions.version, request.revisionVersion),
          ))
          .limit(1),
        app.db
          .select({ role: chatMessages.role, body: chatMessages.body })
          .from(chatMessages)
          .where(eq(chatMessages.threadId, request.threadId))
          .orderBy(asc(chatMessages.seq)),
      ])
      return { origin: origin ?? null, system: system ?? null, revision: revision ?? null, messages }
    })
    if (!context.origin || !context.system || !context.revision) {
      throw new Error('The credential handoff lost its originating work.')
    }

    const recentConversation = context.messages
      .slice(-12)
      .map((message) => `${message.role === 'agent' ? 'Employee' : message.role === 'user' ? 'Operator' : 'System'}: ${message.body}`)
      .join('\n\n')
      .slice(-10_000)
    const resume = context.origin.status === 'waiting_credential' && Boolean(context.origin.transcript)
    const { executeAgentRun } = await import('./agent-runs')
    const continued = await executeAgentRun({
      tenantId,
      personId: request.personId,
      trigger: resume
        ? context.origin.trigger
        : { type: 'credential_followup', requestId: request.id, originRunId: context.origin.id },
      input: {
        type: 'credential_stored',
        requestId: request.id,
        systemName: context.system.name,
        purpose: request.purpose,
        toolCount: context.revision.definition.operations.length,
        ...(resume ? {} : { conversation: recentConversation }),
      },
      ...(resume ? { resumeRunId: context.origin.id } : {}),
    })
    const { appendCredentialOutcomeToChat } = await import('./chat-threads')
    await appendCredentialOutcomeToChat({
      tenantId,
      threadId: request.threadId,
      requestId: request.id,
      continuedRunId: continued.runId,
      outcome: continued.outcome,
    })
    await settleStoredCredentialContinuation({ tenantId, requestId: request.id, runId: continued.runId })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await settleStoredCredentialContinuation({ tenantId, requestId: request.id, error: message })
    throw error
  }
}

export async function cancelSystemCredentialRequest(args: {
  tenantId: string
  threadId: string
  requestId: string
  userId: string
}): Promise<void> {
  const app = db()
  await app.withTenant(args.tenantId, () => app.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${args.tenantId}:${args.requestId}`}, 0))`)
    const [request] = await tx
      .select()
      .from(authoredSystemCredentialRequests)
      .where(and(
        eq(authoredSystemCredentialRequests.id, args.requestId),
        eq(authoredSystemCredentialRequests.threadId, args.threadId),
      ))
      .limit(1)
    if (!request || request.status === 'cancelled') return
    if (request.status !== 'pending') throw new Error('That credential request cannot be cancelled now.')
    const now = new Date()
    await tx.update(authoredSystemCredentialRequests).set({
      status: 'cancelled',
      resolvedAt: now,
      resolvedBy: args.userId,
      updatedAt: now,
      updatedBy: args.userId,
    }).where(eq(authoredSystemCredentialRequests.id, request.id))
    await appendRequestEvent(tx, {
      tenantId: args.tenantId,
      requestId: request.id,
      kind: 'cancelled',
      actorType: 'user',
      actorId: args.userId,
    })
  }))
}
