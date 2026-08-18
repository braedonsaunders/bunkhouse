import { foreignKey, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@braedonsaunders/appkit-db'
import type { SealedSecret } from '@braedonsaunders/appkit-crypto'
import type { RemoteControlScope, RemoteProtocol, RemoteSessionEventDetail, RemoteSurfaceKind } from '@braedonsaunders/appkit-remote-sessions'

export const remoteComputerStatus = pgEnum('remote_computer_status', ['ready', 'unreachable', 'disabled'])
export const remoteSessionStatus = pgEnum('remote_session_status', ['opening', 'connected', 'idle', 'closed', 'failed'])

/** A customer-owned computer exposed by an authenticated remote-access provider. */
export const remoteComputers = pgTable('remote_computers', {
  id: id(),
  tenantId: tenantRef(),
  name: text('name').notNull(),
  host: text('host').notNull(),
  port: integer('port').notNull(),
  protocol: text('protocol').$type<RemoteProtocol>().notNull(),
  provider: text('provider').$type<'steward'>().notNull().default('steward'),
  providerBaseUrl: text('provider_base_url').notNull(),
  providerTargetId: text('provider_target_id').notNull(),
  sealedProviderToken: jsonb('sealed_provider_token').$type<SealedSecret>(),
  status: remoteComputerStatus('status').notNull().default('ready'),
  lastConnectedAt: timestamp('last_connected_at', { withTimezone: true }),
  lastError: text('last_error'),
  ...auditColumns,
}, (t) => [
  uniqueIndex('remote_computers_tenant_id_ux').on(t.tenantId, t.id),
  uniqueIndex('remote_computers_provider_target_ux').on(t.tenantId, t.provider, t.providerTargetId),
  index('remote_computers_status_idx').on(t.tenantId, t.status, t.name),
])

/** A run-bound external computer or terminal session. Viewer credentials are never persisted. */
export const remoteSessions = pgTable('remote_sessions', {
  id: id(),
  tenantId: tenantRef(),
  computerId: uuid('computer_id').notNull(),
  personId: uuid('person_id').notNull(),
  runId: uuid('run_id').notNull(),
  kind: text('kind').$type<RemoteSurfaceKind>().notNull(),
  protocol: text('protocol').$type<RemoteProtocol>().notNull(),
  status: remoteSessionStatus('status').notNull().default('opening'),
  providerSessionId: text('provider_session_id'),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  connectedAt: timestamp('connected_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
  lastError: text('last_error'),
  eventSeq: integer('event_seq').notNull().default(0),
  leaseFence: integer('lease_fence').notNull().default(0),
  ...auditColumns,
}, (t) => [
  uniqueIndex('remote_sessions_tenant_id_ux').on(t.tenantId, t.id),
  foreignKey({ columns: [t.tenantId, t.computerId], foreignColumns: [remoteComputers.tenantId, remoteComputers.id], name: 'remote_sessions_tenant_computer_fk' }).onDelete('restrict'),
  index('remote_sessions_run_idx').on(t.tenantId, t.runId, t.openedAt),
  index('remote_sessions_person_idx').on(t.tenantId, t.personId, t.openedAt),
])

/** Immutable lease grant; release/expiry/revocation are new event rows, never updates. */
export const remoteSessionLeases = pgTable('remote_session_leases', {
  id: id(),
  tenantId: tenantRef(),
  sessionId: uuid('session_id').notNull(),
  holder: text('holder').notNull(),
  purpose: text('purpose').notNull(),
  scope: text('scope').$type<RemoteControlScope>().notNull(),
  exclusive: integer('exclusive').notNull().default(0),
  fence: integer('fence').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ columns: [t.tenantId, t.sessionId], foreignColumns: [remoteSessions.tenantId, remoteSessions.id], name: 'remote_session_leases_tenant_session_fk' }).onDelete('restrict'),
  uniqueIndex('remote_session_leases_fence_ux').on(t.sessionId, t.fence),
  index('remote_session_leases_session_idx').on(t.tenantId, t.sessionId, t.expiresAt),
])

/** Append-only evidence for the human-visible remote work surface. */
export const remoteSessionEvents = pgTable('remote_session_events', {
  id: id(),
  tenantId: tenantRef(),
  sessionId: uuid('session_id').notNull(),
  seq: integer('seq').notNull(),
  kind: text('kind').$type<RemoteSessionEventDetail['kind']>().notNull(),
  detail: jsonb('detail').$type<RemoteSessionEventDetail>().notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ columns: [t.tenantId, t.sessionId], foreignColumns: [remoteSessions.tenantId, remoteSessions.id], name: 'remote_session_events_tenant_session_fk' }).onDelete('restrict'),
  uniqueIndex('remote_session_events_seq_ux').on(t.sessionId, t.seq),
  index('remote_session_events_session_idx').on(t.tenantId, t.sessionId, t.at),
])

export const REMOTE_TENANT_TABLES = ['remote_computers', 'remote_sessions', 'remote_session_leases', 'remote_session_events'] as const
