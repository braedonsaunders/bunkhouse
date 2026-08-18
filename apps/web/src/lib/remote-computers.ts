import 'server-only'

import { and, asc, desc, eq, gt, sql } from 'drizzle-orm'
import { sealSecret, unsealSecret } from '@braedonsaunders/appkit-crypto'
import {
  createRemoteSessionService,
  type RemoteCommandChunk,
  type RemoteComputerAction,
  type RemoteLease,
  type RemoteSession,
  type RemoteSessionEvent,
  type RemoteSessionEventDetail,
  type RemoteSessionProvider,
  type RemoteSessionStore,
  type RemoteTarget,
} from '@braedonsaunders/appkit-remote-sessions'
import { db } from '../db/client'
import { remoteComputers, remoteSessionEvents, remoteSessionLeases, remoteSessions } from '../db/schema'
import { resolveDeskFeatures } from './desk-policy'

export type RemoteComputerInput = {
  id?: string
  name: string
  host: string
  port: number
  protocol: 'rdp' | 'vnc' | 'ssh' | 'winrm' | 'powershell-ssh' | 'telnet'
  providerBaseUrl: string
  providerTargetId: string
  providerToken?: string
  enabled?: boolean
}

function normalizedBaseUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname))) {
    throw new Error('Remote provider URL must use HTTPS, except for a local Steward server.')
  }
  url.pathname = url.pathname.replace(/\/$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function boundedPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error('Remote computer port must be from 1 to 65535.')
  return value
}

export async function listRemoteComputers(tenantId: string) {
  const app = db()
  return app.withTenantContext(tenantId, () => app.db.select().from(remoteComputers).orderBy(asc(remoteComputers.name)))
}

export async function saveRemoteComputer(tenantId: string, actorId: string, input: RemoteComputerInput) {
  const name = input.name.trim()
  const host = input.host.trim()
  const providerTargetId = input.providerTargetId.trim()
  if (!name || !host || !providerTargetId) throw new Error('Name, host, and Steward device are required.')
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const current = input.id
      ? (await app.db.select().from(remoteComputers).where(eq(remoteComputers.id, input.id)).limit(1))[0]
      : null
    const sealedProviderToken = input.providerToken?.trim()
      ? sealSecret(input.providerToken.trim())
      : current?.sealedProviderToken ?? null
    if (!sealedProviderToken) throw new Error('A Steward API token is required.')
    const values = {
      tenantId,
      name,
      host,
      port: boundedPort(input.port),
      protocol: input.protocol,
      provider: 'steward' as const,
      providerBaseUrl: normalizedBaseUrl(input.providerBaseUrl),
      providerTargetId,
      sealedProviderToken,
      status: input.enabled === false ? 'disabled' as const : 'ready' as const,
      updatedBy: actorId,
      updatedAt: new Date(),
    }
    if (current) {
      const [saved] = await app.db.update(remoteComputers).set(values).where(eq(remoteComputers.id, current.id)).returning()
      return saved
    }
    const [saved] = await app.db.insert(remoteComputers).values({ ...values, createdBy: actorId }).returning()
    return saved
  })
}

export async function disableRemoteComputer(tenantId: string, actorId: string, id: string): Promise<void> {
  const app = db()
  await app.withTenantContext(tenantId, async () => {
    const active = await app.db.select({ id: remoteSessions.id }).from(remoteSessions)
      .where(and(eq(remoteSessions.computerId, id), eq(remoteSessions.status, 'connected'))).limit(1)
    if (active.length) throw new Error('Disconnect this computer before disabling it.')
    await app.db.update(remoteComputers).set({ status: 'disabled', updatedBy: actorId, updatedAt: new Date() }).where(eq(remoteComputers.id, id))
  })
}

export async function testRemoteComputer(tenantId: string, id: string): Promise<void> {
  const app = db()
  const row = await computerRow(tenantId, id)
  const target = targetOf(row)
  try {
    const credential = row.sealedProviderToken ? unsealSecret(row.sealedProviderToken) : null
    await stewardFetch(target, credential, `/api/devices/${encodeURIComponent(row.providerTargetId)}/remote-terminal`)
    await app.withTenantContext(tenantId, () => app.db.update(remoteComputers).set({
      status: 'ready', lastConnectedAt: new Date(), lastError: null, updatedAt: new Date(),
    }).where(eq(remoteComputers.id, id)))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await app.withTenantContext(tenantId, () => app.db.update(remoteComputers).set({
      status: 'unreachable', lastError: message, updatedAt: new Date(),
    }).where(eq(remoteComputers.id, id)))
    throw error
  }
}

function targetOf(row: typeof remoteComputers.$inferSelect): RemoteTarget {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    host: row.host,
    port: row.port,
    protocol: row.protocol,
    credentialRef: row.id,
    metadata: { providerBaseUrl: row.providerBaseUrl, providerTargetId: row.providerTargetId },
  }
}

function sessionOf(row: typeof remoteSessions.$inferSelect): RemoteSession {
  return {
    id: row.id, tenantId: row.tenantId, targetId: row.computerId, runId: row.runId, personId: row.personId,
    kind: row.kind, protocol: row.protocol, status: row.status, providerSessionId: row.providerSessionId,
    openedAt: row.openedAt.toISOString(), connectedAt: row.connectedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null, lastActivityAt: row.lastActivityAt.toISOString(), lastError: row.lastError,
  }
}

function leaseOf(row: typeof remoteSessionLeases.$inferSelect): RemoteLease {
  return {
    id: row.id, tenantId: row.tenantId, sessionId: row.sessionId, holder: row.holder, purpose: row.purpose,
    scope: row.scope, exclusive: row.exclusive === 1, fence: row.fence,
    grantedAt: row.grantedAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
  }
}

function storeFor(tenantId: string): RemoteSessionStore {
  const app = db()
  return {
    async createSession(session) {
      await app.withTenantContext(tenantId, () => app.db.insert(remoteSessions).values({
        id: session.id, tenantId, computerId: session.targetId, personId: session.personId!, runId: session.runId!,
        kind: session.kind, protocol: session.protocol, status: session.status, providerSessionId: session.providerSessionId,
        openedAt: new Date(session.openedAt), connectedAt: session.connectedAt ? new Date(session.connectedAt) : null,
        closedAt: session.closedAt ? new Date(session.closedAt) : null, lastActivityAt: new Date(session.lastActivityAt), lastError: session.lastError,
      }))
    },
    async updateSession(session) {
      await app.withTenantContext(tenantId, () => app.db.update(remoteSessions).set({
        status: session.status, providerSessionId: session.providerSessionId,
        connectedAt: session.connectedAt ? new Date(session.connectedAt) : null,
        closedAt: session.closedAt ? new Date(session.closedAt) : null,
        lastActivityAt: new Date(session.lastActivityAt), lastError: session.lastError,
      }).where(eq(remoteSessions.id, session.id)))
    },
    async getSession(scopeTenantId, sessionId) {
      if (scopeTenantId !== tenantId) return null
      const [row] = await app.withTenantContext(tenantId, () => app.db.select().from(remoteSessions).where(eq(remoteSessions.id, sessionId)).limit(1))
      return row ? sessionOf(row) : null
    },
    async appendLease(lease) {
      await app.withTenantContext(tenantId, () => app.db.insert(remoteSessionLeases).values({
        id: lease.id, tenantId, sessionId: lease.sessionId, holder: lease.holder, purpose: lease.purpose,
        scope: lease.scope, exclusive: lease.exclusive ? 1 : 0, fence: lease.fence,
        grantedAt: new Date(lease.grantedAt), expiresAt: new Date(lease.expiresAt),
      }))
    },
    async getLease(scopeTenantId, leaseId) {
      if (scopeTenantId !== tenantId) return null
      const [row] = await app.withTenantContext(tenantId, () => app.db.select().from(remoteSessionLeases).where(eq(remoteSessionLeases.id, leaseId)).limit(1))
      return row ? leaseOf(row) : null
    },
    async appendEvent(event) {
      const detailRecord = structuredClone(event) as unknown as Record<string, unknown>
      delete detailRecord.id
      delete detailRecord.tenantId
      delete detailRecord.sessionId
      delete detailRecord.seq
      delete detailRecord.at
      const detail = detailRecord as RemoteSessionEventDetail
      await app.withTenantContext(tenantId, () => app.db.insert(remoteSessionEvents).values({
        id: event.id, tenantId, sessionId: event.sessionId, seq: event.seq, kind: event.kind, detail, at: new Date(event.at),
      }))
    },
    async eventsAfter(scopeTenantId, sessionId, afterSeq, limit) {
      if (scopeTenantId !== tenantId) return []
      const rows = await app.withTenantContext(tenantId, () => app.db.select().from(remoteSessionEvents)
        .where(and(eq(remoteSessionEvents.sessionId, sessionId), gt(remoteSessionEvents.seq, afterSeq)))
        .orderBy(asc(remoteSessionEvents.seq)).limit(Math.max(1, Math.min(limit, 500))))
      return rows.map((row) => ({ ...row.detail, id: row.id, tenantId: row.tenantId, sessionId: row.sessionId, seq: row.seq, at: row.at.toISOString() } as RemoteSessionEvent))
    },
    async nextEventSeq(scopeTenantId, sessionId) {
      if (scopeTenantId !== tenantId) throw new Error('Remote session tenant mismatch.')
      const [row] = await app.withTenantContext(tenantId, () => app.db.update(remoteSessions)
        .set({ eventSeq: sql`${remoteSessions.eventSeq} + 1` }).where(eq(remoteSessions.id, sessionId))
        .returning({ value: remoteSessions.eventSeq }))
      if (!row) throw new Error('Remote session was not found.')
      return row.value
    },
    async nextFence(scopeTenantId, sessionId) {
      if (scopeTenantId !== tenantId) throw new Error('Remote session tenant mismatch.')
      const [row] = await app.withTenantContext(tenantId, () => app.db.update(remoteSessions)
        .set({ leaseFence: sql`${remoteSessions.leaseFence} + 1` }).where(eq(remoteSessions.id, sessionId))
        .returning({ value: remoteSessions.leaseFence }))
      if (!row) throw new Error('Remote session was not found.')
      return row.value
    },
    async isLeaseActive(scopeTenantId, leaseId, now) {
      if (scopeTenantId !== tenantId) return false
      const rows = await app.withTenantContext(tenantId, () => app.db.select({ id: remoteSessionLeases.id }).from(remoteSessionLeases)
        .where(and(
          eq(remoteSessionLeases.id, leaseId),
          gt(remoteSessionLeases.expiresAt, new Date(now)),
          sql`not exists (select 1 from remote_session_events e where e.session_id = ${remoteSessionLeases.sessionId} and e.kind = 'lease_released' and e.detail->>'leaseId' = ${leaseId})`,
        )).limit(1))
      return rows.length === 1
    },
    async consumeGrant() {
      // Viewer grants are exchanged by the authenticated server action below;
      // Bunkhouse never exposes a reusable AppKit grant to the browser.
      return true
    },
  }
}

function metadata(target: RemoteTarget): { baseUrl: string; targetId: string } {
  const baseUrl = typeof target.metadata?.providerBaseUrl === 'string' ? target.metadata.providerBaseUrl : ''
  const targetId = typeof target.metadata?.providerTargetId === 'string' ? target.metadata.providerTargetId : ''
  if (!baseUrl || !targetId) throw new Error('Remote computer provider configuration is incomplete.')
  return { baseUrl, targetId }
}

async function stewardFetch(target: RemoteTarget, token: string | null, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  if (!token) throw new Error('The Steward API token cannot be unsealed. Re-enter it in Settings → Remote computers.')
  const { baseUrl } = metadata(target)
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    cache: 'no-store',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `Steward returned ${response.status}.`)
  return body
}

const stewardProvider: RemoteSessionProvider = {
  async open({ session, target, credential, scope, signal }) {
    const { targetId } = metadata(target)
    if (session.kind === 'terminal') {
      await stewardFetch(target, credential, `/api/devices/${encodeURIComponent(targetId)}/remote-terminal`, { signal })
      return { providerSessionId: `terminal:${targetId}` }
    }
    const body = await stewardFetch(target, credential, '/api/remote-desktop/sessions', {
      method: 'POST', signal,
      body: JSON.stringify({ deviceId: targetId, protocol: target.protocol, host: target.host, port: target.port, holder: `bunkhouse:${session.personId ?? session.id}`, purpose: 'Agent working on a connected computer', mode: scope === 'control' ? 'command' : 'observe', exclusive: scope === 'control' }),
    })
    const remote = body.session as { id?: unknown } | undefined
    if (typeof remote?.id !== 'string') throw new Error('Steward did not return a remote session id.')
    return { providerSessionId: remote.id }
  },
  async viewer({ session, lease, target, credential, signal }) {
    if (!session.providerSessionId) throw new Error('The remote computer is not connected.')
    const body = await stewardFetch(target, credential, `/api/remote-desktop/sessions/${encodeURIComponent(session.providerSessionId)}/viewer-token`, {
      method: 'POST', signal,
      body: JSON.stringify({ holder: lease.holder, purpose: lease.purpose, mode: lease.scope === 'control' ? 'command' : 'observe', exclusive: lease.exclusive, viewerTtlMs: 10 * 60_000 }),
    })
    const viewerPath = typeof body.viewerPath === 'string' ? body.viewerPath : null
    const expiresAt = typeof body.viewerTokenExpiresAt === 'string' ? body.viewerTokenExpiresAt : null
    if (!viewerPath || !expiresAt) throw new Error('Steward did not return a viewer connection.')
    return { url: new URL(viewerPath, `${metadata(target).baseUrl}/`).toString(), expiresAt }
  },
  async *command({ target, credential, command, cwd, signal }): AsyncIterable<RemoteCommandChunk> {
    const { targetId } = metadata(target)
    const body = await stewardFetch(target, credential, `/api/devices/${encodeURIComponent(targetId)}/remote-terminal`, {
      method: 'POST', signal, body: JSON.stringify({ command, ...(cwd ? { cwd } : {}) }),
    })
    const output = typeof body.output === 'string' ? body.output : typeof body.summary === 'string' ? body.summary : ''
    if (output) yield { kind: body.ok === false ? 'stderr' : 'stdout', text: output }
    yield { kind: 'exit', exitCode: body.ok === false ? 1 : 0, signal: null }
  },
  async control({ session, target, credential, action, signal }) {
    if (!session.providerSessionId) throw new Error('The remote computer is not connected.')
    const step = action.action === 'drag'
      ? { ...action, from_x: action.fromX, from_y: action.fromY, to_x: action.toX, to_y: action.toY, duration_ms: action.durationMs }
      : action.action === 'wait'
        ? { ...action, duration_ms: action.durationMs }
        : action
    const body = await stewardFetch(target, credential, `/api/remote-desktop/sessions/${encodeURIComponent(session.providerSessionId)}/actions`, {
      method: 'POST', signal,
      body: JSON.stringify({ holder: `bunkhouse:${session.personId ?? session.id}`, purpose: 'Agent operating a connected computer', step }),
    })
    const screenshot = typeof body.screenshotBase64 === 'string' ? body.screenshotBase64 : null
    const mimeType = typeof body.mimeType === 'string' ? body.mimeType : 'image/png'
    return {
      ok: body.ok !== false,
      ...(typeof body.error === 'string' ? { message: body.error } : {}),
      ...(screenshot ? { frame: { mimeType, data: screenshot } } : {}),
    }
  },
  async close() {
    // Steward sessions are lease-bound and expire server-side. Bunkhouse closes
    // its own durable surface immediately without retaining a provider grant.
  },
}

async function computerRow(tenantId: string, id: string) {
  const app = db()
  const [row] = await app.withTenantContext(tenantId, () => app.db.select().from(remoteComputers).where(eq(remoteComputers.id, id)).limit(1))
  if (!row || row.status === 'disabled') throw new Error('Remote computer is unavailable.')
  return row
}

function serviceFor(tenantId: string) {
  return createRemoteSessionService({
    store: storeFor(tenantId),
    provider: stewardProvider,
    policy: { allowOpen: () => true, allowViewer: () => true, allowCommand: () => true },
    resolveTarget: async (scopeTenantId, targetId) => scopeTenantId === tenantId ? targetOf(await computerRow(tenantId, targetId)) : null,
    resolveCredential: async (target) => {
      const row = await computerRow(tenantId, target.id)
      return row.sealedProviderToken ? unsealSecret(row.sealedProviderToken) : null
    },
  })
}

async function requireRemoteComputersEnabled(tenantId: string): Promise<void> {
  if (!(await resolveDeskFeatures(tenantId)).remoteComputers) {
    throw new Error('Remote computers are turned off in Company Settings → Features.')
  }
}

export async function openRemoteWork(input: { tenantId: string; computerId: string; personId: string; runId: string; kind: 'computer' | 'terminal' }) {
  await requireRemoteComputersEnabled(input.tenantId)
  const computer = await computerRow(input.tenantId, input.computerId)
  return serviceFor(input.tenantId).open({ target: targetOf(computer), runId: input.runId, personId: input.personId, kind: input.kind, scope: 'control' })
}

export async function observeRemoteWork(input: { tenantId: string; sessionId: string; holder: string }) {
  await requireRemoteComputersEnabled(input.tenantId)
  const service = serviceFor(input.tenantId)
  const lease = await service.lease({ tenantId: input.tenantId, sessionId: input.sessionId, holder: input.holder, purpose: 'Watch the agent work', scope: 'observe', ttlMs: 10 * 60_000 })
  return service.viewer({ tenantId: input.tenantId, sessionId: input.sessionId, leaseId: lease.id })
}

export async function runRemoteCommand(input: { tenantId: string; sessionId: string; command: string; cwd?: string }) {
  await requireRemoteComputersEnabled(input.tenantId)
  return serviceFor(input.tenantId).command(input)
}

export async function controlRemoteComputer(input: { tenantId: string; sessionId: string; action: RemoteComputerAction }) {
  await requireRemoteComputersEnabled(input.tenantId)
  return serviceFor(input.tenantId).control(input)
}

export async function closeRemoteWork(input: { tenantId: string; sessionId: string; reason?: 'completed' | 'cancelled' | 'operator' | 'provider_lost' }) {
  await requireRemoteComputersEnabled(input.tenantId)
  return serviceFor(input.tenantId).close(input)
}

export async function recentRemoteSessions(tenantId: string, limit = 50) {
  const app = db()
  return app.withTenantContext(tenantId, () => app.db.select({ session: remoteSessions, computer: remoteComputers })
    .from(remoteSessions).innerJoin(remoteComputers, eq(remoteComputers.id, remoteSessions.computerId))
    .orderBy(desc(remoteSessions.openedAt)).limit(Math.max(1, Math.min(limit, 200))))
}
