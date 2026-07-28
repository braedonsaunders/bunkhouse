import { index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@appkit/db'

/**
 * The autonomy dial: per hand × action category, how much trust it has. The
 * runtime enforces these levels — a prompt never grants what the dial denies.
 * 'approval' queues the action; 'notify' performs it and tells the manager;
 * 'trusted' just does it.
 */
export const actionCategory = pgEnum('action_category', [
  'external_email',
  'internal_email',
  'record_write',
  'money_adjacent',
  'file_write',
  'computer_use',
  'shell',
])

export const autonomyLevel = pgEnum('autonomy_level', ['forbidden', 'approval', 'notify', 'trusted'])

export const autonomySettings = pgTable(
  'autonomy_settings',
  {
    id: id(),
    tenantId: tenantRef(),
    personId: uuid('person_id').notNull(),
    category: actionCategory('category').notNull(),
    level: autonomyLevel('level').notNull(),
    ...auditColumns,
  },
  (t) => [uniqueIndex('autonomy_settings_key').on(t.tenantId, t.personId, t.category)],
)

export const approvalStatus = pgEnum('approval_status', ['pending', 'approved', 'rejected', 'expired'])

export type ApprovalPayload = {
  /** Human-readable rendering of exactly what will happen if approved. */
  description: string
  /** The pending action, replayable by the runtime on approval. */
  action: Record<string, unknown>
}

export const approvals = pgTable(
  'approvals',
  {
    id: id(),
    tenantId: tenantRef(),
    runId: uuid('run_id').notNull(),
    /** The hand requesting the action. */
    personId: uuid('person_id').notNull(),
    category: actionCategory('category').notNull(),
    payload: jsonb('payload').$type<ApprovalPayload>().notNull(),
    status: approvalStatus('status').notNull().default('pending'),
    /** Human who decided; null while pending. */
    decidedById: uuid('decided_by_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [index('approvals_pending_idx').on(t.tenantId, t.status, t.createdAt)],
)

export const GOVERNANCE_TENANT_TABLES = ['autonomy_settings', 'approvals'] as const
