import { sql } from 'drizzle-orm'
import { foreignKey, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@braedonsaunders/appkit-db'
import type { SealedSecret } from '@braedonsaunders/appkit-crypto'
import type { HttpSystemDefinition } from '@bunkhouse/runtime'
import type { ResourceAssignment } from './assignment'

export const authoredSystemStatus = pgEnum('authored_system_status', ['proposed', 'active', 'disabled'])
export const authoredSystemHealthStatus = pgEnum('authored_system_health_status', ['ok', 'failed'])
export const authoredSystemCredentialRequestStatus = pgEnum('authored_system_credential_request_status', [
  'pending',
  'verifying',
  'stored',
  'cancelled',
  'expired',
])
export const authoredSystemCredentialRequestEventKind = pgEnum('authored_system_credential_request_event_kind', [
  'requested',
  'verification_started',
  'verification_failed',
  'stored',
  'cancelled',
  'expired',
])

/**
 * A company-private system an employee authored. The head is mutable only as a
 * lifecycle pointer; every executable definition lives in an append-only
 * revision so a later edit never changes what an earlier run meant.
 */
export const authoredSystems = pgTable(
  'authored_systems',
  {
    id: id(),
    tenantId: tenantRef(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    status: authoredSystemStatus('status').notNull().default('proposed'),
    latestVersion: integer('latest_version').notNull().default(1),
    /** Null until an operator tests and activates a proposed revision. */
    activeVersion: integer('active_version'),
    assignment: jsonb('assignment').$type<ResourceAssignment>().notNull().default({}),
    /** The employee and run that proposed the latest revision. */
    proposedByPersonId: uuid('proposed_by_person_id'),
    proposedByRunId: uuid('proposed_by_run_id'),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('authored_systems_tenant_slug_ux').on(table.tenantId, table.slug),
    uniqueIndex('authored_systems_tenant_id_ux').on(table.tenantId, table.id),
    index('authored_systems_tenant_status_idx').on(table.tenantId, table.status, table.name),
  ],
)

export type AuthoredSystemValidation = {
  checkedAt: string
  operationCount: number
  healthOperation: string
  baseUrlHost: string
}

/** Immutable executable versions. Approval moves the head pointer; it never edits this row. */
export const authoredSystemRevisions = pgTable(
  'authored_system_revisions',
  {
    id: id(),
    tenantId: tenantRef(),
    systemId: uuid('system_id').notNull(),
    version: integer('version').notNull(),
    definition: jsonb('definition').$type<HttpSystemDefinition>().notNull(),
    validation: jsonb('validation').$type<AuthoredSystemValidation>().notNull(),
    changeNote: text('change_note'),
    proposedByPersonId: uuid('proposed_by_person_id'),
    proposedByRunId: uuid('proposed_by_run_id'),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('authored_system_revisions_version_ux').on(table.systemId, table.version),
    index('authored_system_revisions_tenant_system_idx').on(table.tenantId, table.systemId, table.version),
    foreignKey({
      name: 'authored_system_revisions_tenant_system_fk',
      columns: [table.tenantId, table.systemId],
      foreignColumns: [authoredSystems.tenantId, authoredSystems.id],
    }).onDelete('cascade'),
  ],
)

/** Credentials and operational state are tenant-local and never enter a reusable definition. */
export const authoredSystemConnections = pgTable(
  'authored_system_connections',
  {
    id: id(),
    tenantId: tenantRef(),
    systemId: uuid('system_id').notNull(),
    sealedCredential: jsonb('sealed_credential').$type<SealedSecret>(),
    healthStatus: authoredSystemHealthStatus('health_status'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastError: text('last_error'),
    lastToolCount: integer('last_tool_count'),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('authored_system_connections_system_ux').on(table.systemId),
    index('authored_system_connections_tenant_health_idx').on(table.tenantId, table.healthStatus),
    foreignKey({
      name: 'authored_system_connections_tenant_system_fk',
      columns: [table.tenantId, table.systemId],
      foreignColumns: [authoredSystems.tenantId, authoredSystems.id],
    }).onDelete('cascade'),
  ],
)

/**
 * A durable, conversation-local request for a human to connect a proposed
 * system. The plaintext credential never enters this row: the browser sends
 * it straight to the server action that verifies and seals it in the existing
 * connection projection.
 */
export const authoredSystemCredentialRequests = pgTable(
  'authored_system_credential_requests',
  {
    id: id(),
    tenantId: tenantRef(),
    threadId: uuid('thread_id').notNull(),
    personId: uuid('person_id').notNull(),
    runId: uuid('run_id').notNull(),
    systemId: uuid('system_id').notNull(),
    revisionVersion: integer('revision_version').notNull(),
    credentialLabel: text('credential_label').notNull(),
    purpose: text('purpose').notNull(),
    helpUrl: text('help_url'),
    status: authoredSystemCredentialRequestStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    verificationStartedAt: timestamp('verification_started_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by'),
    /** Recoverable delivery of the stored result back into the originating work. */
    continuationStatus: text('continuation_status')
      .$type<'pending' | 'leased' | 'succeeded' | 'failed'>()
      .notNull()
      .default('pending'),
    continuationAttempts: integer('continuation_attempts').notNull().default(0),
    continuationLeaseUntil: timestamp('continuation_lease_until', { withTimezone: true }),
    continuationError: text('continuation_error'),
    continuedRunId: uuid('continued_run_id'),
    continuedAt: timestamp('continued_at', { withTimezone: true }),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('authored_system_credential_requests_tenant_id_ux').on(table.tenantId, table.id),
    uniqueIndex('authored_system_credential_requests_pending_ux')
      .on(table.tenantId, table.threadId, table.systemId)
      .where(sql`${table.status} in ('pending', 'verifying')`),
    index('authored_system_credential_requests_thread_idx').on(table.tenantId, table.threadId, table.createdAt),
    index('authored_system_credential_requests_system_idx').on(table.tenantId, table.systemId, table.status),
    index('authored_system_credential_requests_continuation_idx')
      .on(table.tenantId, table.continuationStatus, table.continuationLeaseUntil),
    foreignKey({
      name: 'authored_system_credential_requests_tenant_system_fk',
      columns: [table.tenantId, table.systemId],
      foreignColumns: [authoredSystems.tenantId, authoredSystems.id],
    }).onDelete('cascade'),
  ],
)

/** Immutable evidence for every credential-request transition; never secret material. */
export const authoredSystemCredentialRequestEvents = pgTable(
  'authored_system_credential_request_events',
  {
    id: id(),
    tenantId: tenantRef(),
    requestId: uuid('request_id').notNull(),
    seq: integer('seq').notNull(),
    kind: authoredSystemCredentialRequestEventKind('kind').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('authored_system_credential_request_events_seq_ux').on(table.requestId, table.seq),
    index('authored_system_credential_request_events_tenant_idx').on(table.tenantId, table.requestId, table.seq),
    foreignKey({
      name: 'authored_system_credential_request_events_tenant_request_fk',
      columns: [table.tenantId, table.requestId],
      foreignColumns: [authoredSystemCredentialRequests.tenantId, authoredSystemCredentialRequests.id],
    }).onDelete('cascade'),
  ],
)

export const AUTHORED_SYSTEM_TENANT_TABLES = [
  'authored_systems',
  'authored_system_revisions',
  'authored_system_connections',
  'authored_system_credential_requests',
  'authored_system_credential_request_events',
] as const
