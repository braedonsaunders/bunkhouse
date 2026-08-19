import 'server-only'

import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { sealSecret, unsealSecret } from '@braedonsaunders/appkit-crypto'
import { secureFetch } from '@braedonsaunders/appkit-sync'
import {
  buildHttpSystemRequest,
  connectHttpSystem,
  httpSystemDefinitionSchema,
  type Ability,
  type HttpSystemDefinition,
  type HttpSystemRequest,
  type HttpSystemResponse,
} from '@bunkhouse/runtime'
import { schema as identity } from '@braedonsaunders/appkit-db'
import {
  authoredSystemConnections,
  authoredSystemRevisions,
  authoredSystems,
  type ResourceAssignment,
} from '../db/schema'
import { db } from '../db/client'

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000

export type AuthoredSystemRecord = {
  system: typeof authoredSystems.$inferSelect
  /** Latest proposal, shown for review. */
  revision: typeof authoredSystemRevisions.$inferSelect
  /** Currently executable version; may differ while an update awaits review. */
  activeRevision: typeof authoredSystemRevisions.$inferSelect | null
  connection: typeof authoredSystemConnections.$inferSelect | null
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64)
}

function parseDefinition(value: unknown): HttpSystemDefinition {
  const definition = httpSystemDefinitionSchema.parse(value)
  const base = new URL(definition.baseUrl)
  if (base.username || base.password || base.search || base.hash) {
    throw new Error('The base URL cannot contain credentials, query parameters, or a fragment.')
  }
  return definition
}

export async function authoredSystemTransport(request: HttpSystemRequest): Promise<HttpSystemResponse> {
  const response = await secureFetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    ...(request.signal ? { signal: request.signal } : {}),
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    maxRedirects: 2,
  })
  const contentType = response.headers.get('content-type') ?? undefined
  const text = await response.text()
  let body: unknown = text
  if (contentType?.toLowerCase().includes('json') && text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return {
    status: response.status,
    statusText: response.statusText,
    ...(contentType ? { contentType } : {}),
    body,
  }
}

export async function listAuthoredSystems(tenantId: string): Promise<AuthoredSystemRecord[]> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const heads = await app.db.select().from(authoredSystems).orderBy(asc(authoredSystems.name))
    if (heads.length === 0) return []
    const [revisions, connections] = await Promise.all([
      app.db.select().from(authoredSystemRevisions).orderBy(desc(authoredSystemRevisions.version)),
      app.db.select().from(authoredSystemConnections),
    ])
    return heads.flatMap((system) => {
      const revision = revisions.find(
        (candidate) => candidate.systemId === system.id && candidate.version === system.latestVersion,
      )
      if (!revision) return []
      return [{
        system,
        revision,
        activeRevision: system.activeVersion === null
          ? null
          : revisions.find(
              (candidate) => candidate.systemId === system.id && candidate.version === system.activeVersion,
            ) ?? null,
        connection: connections.find((candidate) => candidate.systemId === system.id) ?? null,
      }]
    })
  })
}

export async function proposeAuthoredSystem(args: {
  tenantId: string
  personId: string
  runId: string
  name: string
  slug: string
  description: string
  definition: unknown
  changeNote?: string
}): Promise<{ id: string; slug: string; version: number }> {
  const slug = normalizeSlug(args.slug || args.name)
  if (!slug) throw new Error('Give the proposed system a short slug.')
  const name = args.name.trim()
  const description = args.description.trim()
  if (!name) throw new Error('Give the proposed system a name.')
  if (!description) throw new Error('Describe what the system lets employees do.')
  const definition = parseDefinition(args.definition)
  const base = new URL(definition.baseUrl)
  const validation = {
    checkedAt: new Date().toISOString(),
    operationCount: definition.operations.length,
    healthOperation: definition.healthCheck.operation,
    baseUrlHost: base.hostname,
  }
  const app = db()
  return app.withTenant(args.tenantId, () => app.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${args.tenantId}:${slug}`}, 0))`)
    const [existing] = await tx
      .select()
      .from(authoredSystems)
      .where(and(eq(authoredSystems.tenantId, args.tenantId), eq(authoredSystems.slug, slug)))
      .limit(1)
    const version = (existing?.latestVersion ?? 0) + 1
    const [system] = existing
      ? await tx
          .update(authoredSystems)
          .set({
            name,
            description,
            latestVersion: version,
            proposedByPersonId: args.personId,
            proposedByRunId: args.runId,
            updatedAt: new Date(),
          })
          .where(eq(authoredSystems.id, existing.id))
          .returning()
      : await tx
          .insert(authoredSystems)
          .values({
            tenantId: args.tenantId,
            slug,
            name,
            description,
            status: 'proposed',
            latestVersion: version,
            assignment: {},
            proposedByPersonId: args.personId,
            proposedByRunId: args.runId,
          })
          .returning()
    if (!system) throw new Error('The system proposal could not be saved.')
    await tx.insert(authoredSystemRevisions).values({
      tenantId: args.tenantId,
      systemId: system.id,
      version,
      definition,
      validation,
      changeNote: args.changeNote?.trim() || null,
      proposedByPersonId: args.personId,
      proposedByRunId: args.runId,
    })
    await tx.insert(identity.auditLog).values({
      tenantId: args.tenantId,
      entityType: 'authored_system',
      entityId: system.id,
      action: existing ? 'revision_proposed' : 'proposal_created',
      summary: `${name} version ${version} proposed by an employee`,
      before: existing ? {
        latestVersion: existing.latestVersion,
        activeVersion: existing.activeVersion,
        status: existing.status,
      } : null,
      after: { slug, name, latestVersion: version, activeVersion: system.activeVersion, status: system.status },
      metadata: { personId: args.personId, runId: args.runId, operationCount: definition.operations.length },
    })
    return { id: system.id, slug, version }
  }))
}

function credentialFor(record: AuthoredSystemRecord, replacement?: string): string | undefined {
  if (record.revision.definition.auth.kind === 'none') return undefined
  const supplied = replacement?.trim()
  if (supplied) return supplied
  const kept = record.connection?.sealedCredential ? unsealSecret(record.connection.sealedCredential) : null
  if (!kept) throw new Error('Enter the credential this system requires.')
  return kept
}

export async function probeAuthoredSystem(
  tenantId: string,
  record: AuthoredSystemRecord,
  replacementCredential?: string,
): Promise<{ ok: true; toolCount: number } | { ok: false; message: string }> {
  const credential = credentialFor(record, replacementCredential)
  const definition = parseDefinition(record.revision.definition)
  const operation = definition.operations.find((candidate) => candidate.name === definition.healthCheck.operation)!
  try {
    const request = buildHttpSystemRequest({
      definition,
      operation,
      input: definition.healthCheck.input,
      ...(credential ? { authValue: credential } : {}),
    })
    const response = await authoredSystemTransport(request)
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${operation.title} returned ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`)
    }
    const app = db()
    await app.withTenant(tenantId, () => app.db
      .insert(authoredSystemConnections)
      .values({
        tenantId,
        systemId: record.system.id,
        sealedCredential: credential ? sealSecret(credential) : null,
        healthStatus: 'ok',
        lastCheckedAt: new Date(),
        lastToolCount: definition.operations.length,
        lastError: null,
      })
      .onConflictDoUpdate({
        target: authoredSystemConnections.systemId,
        set: {
          sealedCredential: credential ? sealSecret(credential) : null,
          healthStatus: 'ok',
          lastCheckedAt: new Date(),
          lastToolCount: definition.operations.length,
          lastError: null,
          updatedAt: new Date(),
        },
      }))
    return { ok: true, toolCount: definition.operations.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const app = db()
    await app.withTenant(tenantId, () => app.db
      .insert(authoredSystemConnections)
      .values({
        tenantId,
        systemId: record.system.id,
        healthStatus: 'failed',
        lastCheckedAt: new Date(),
        lastError: message,
      })
      .onConflictDoUpdate({
        target: authoredSystemConnections.systemId,
        set: {
          healthStatus: 'failed',
          lastCheckedAt: new Date(),
          lastError: message,
          updatedAt: new Date(),
        },
      }))
    return { ok: false, message }
  }
}

export async function activateAuthoredSystem(args: {
  tenantId: string
  systemId: string
  actorUserId: string
  credential?: string
  assignment: ResourceAssignment
}): Promise<{ toolCount: number }> {
  const records = await listAuthoredSystems(args.tenantId)
  const record = records.find((candidate) => candidate.system.id === args.systemId)
  if (!record) throw new Error('That system proposal no longer exists.')
  const probe = await probeAuthoredSystem(args.tenantId, record, args.credential)
  if (!probe.ok) throw new Error(`The connection test failed: ${probe.message}`)
  const app = db()
  await app.withTenant(args.tenantId, () => app.db.transaction(async (tx) => {
    const [fresh] = await tx.select().from(authoredSystems).where(eq(authoredSystems.id, args.systemId)).limit(1)
    if (!fresh || fresh.latestVersion !== record.system.latestVersion) {
      throw new Error('A newer proposal arrived while this one was being tested. Review that version before activating it.')
    }
    await tx.update(authoredSystems).set({
      status: 'active',
      activeVersion: fresh.latestVersion,
      assignment: args.assignment,
      updatedAt: new Date(),
      updatedBy: args.actorUserId,
    }).where(eq(authoredSystems.id, fresh.id))
    await tx.insert(identity.auditLog).values({
      tenantId: args.tenantId,
      actorUserId: args.actorUserId,
      entityType: 'authored_system',
      entityId: fresh.id,
      action: 'activated',
      summary: `${fresh.name} version ${fresh.latestVersion} tested and activated`,
      before: { status: fresh.status, activeVersion: fresh.activeVersion, assignment: fresh.assignment },
      after: { status: 'active', activeVersion: fresh.latestVersion, assignment: args.assignment },
      metadata: { operationCount: probe.toolCount },
    })
  }))
  return { toolCount: probe.toolCount }
}

export async function disableAuthoredSystem(args: {
  tenantId: string
  systemId: string
  actorUserId: string
}): Promise<void> {
  const app = db()
  await app.withTenant(args.tenantId, () => app.db.transaction(async (tx) => {
    const [before] = await tx.select().from(authoredSystems).where(eq(authoredSystems.id, args.systemId)).limit(1)
    if (!before) throw new Error('That system no longer exists.')
    await tx.update(authoredSystems).set({ status: 'disabled', updatedAt: new Date(), updatedBy: args.actorUserId })
      .where(eq(authoredSystems.id, args.systemId))
    await tx.insert(identity.auditLog).values({
      tenantId: args.tenantId,
      actorUserId: args.actorUserId,
      entityType: 'authored_system',
      entityId: before.id,
      action: 'disabled',
      summary: `${before.name} disabled`,
      before: { status: before.status },
      after: { status: 'disabled' },
    })
  }))
}

export async function setAuthoredSystemAssignment(args: {
  tenantId: string
  systemId: string
  actorUserId: string
  assignment: ResourceAssignment
}): Promise<void> {
  const app = db()
  await app.withTenant(args.tenantId, () => app.db.transaction(async (tx) => {
    const [before] = await tx.select().from(authoredSystems).where(eq(authoredSystems.id, args.systemId)).limit(1)
    if (!before) throw new Error('That system no longer exists.')
    await tx.update(authoredSystems).set({
      assignment: args.assignment,
      updatedAt: new Date(),
      updatedBy: args.actorUserId,
    }).where(eq(authoredSystems.id, args.systemId))
    await tx.insert(identity.auditLog).values({
      tenantId: args.tenantId,
      actorUserId: args.actorUserId,
      entityType: 'authored_system',
      entityId: before.id,
      action: 'assignment_updated',
      summary: `${before.name} assignment updated`,
      before: { assignment: before.assignment },
      after: { assignment: args.assignment },
    })
  }))
}

export function authoredSystemAbilities(record: AuthoredSystemRecord): { abilities: Ability[]; secrets: string[] } {
  if (record.system.status !== 'active' || !record.activeRevision) {
    return { abilities: [], secrets: [] }
  }
  const activeRecord = { ...record, revision: record.activeRevision }
  const credential = credentialFor(activeRecord)
  return {
    abilities: connectHttpSystem({
      slug: record.system.slug,
      definition: record.activeRevision.definition,
      ...(credential ? { authValue: credential } : {}),
      transport: authoredSystemTransport,
    }),
    secrets: credential ? [credential] : [],
  }
}
