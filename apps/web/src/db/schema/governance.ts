import { sql } from 'drizzle-orm'
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@braedonsaunders/appkit-db'

/**
 * The autonomy dial: per agent × action category, how much trust it has. The
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
  'phone_call',
  'sandbox',
  'desktop',
  'shared_folder',
  'background_job',
  // Retired by the desk cutover (0054) but still present in the pg type —
  // postgres cannot drop enum values, and historical approvals rows carry
  // them. The runtime's ActionCategory union no longer admits them, which is
  // what keeps new rows out.
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
export const approvalExecutionStatus = pgEnum('approval_execution_status', ['pending', 'leased', 'succeeded', 'failed'])

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
    /** The agent requesting the action. */
    personId: uuid('person_id').notNull(),
    category: actionCategory('category').notNull(),
    payload: jsonb('payload').$type<ApprovalPayload>().notNull(),
    status: approvalStatus('status').notNull().default('pending'),
    /** Human who decided; null while pending. */
    decidedById: uuid('decided_by_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /**
     * When the decided action was carried out (or the decline was delivered
     * back to the agent). The executor claims rows where this is null — so a
     * decision is acted on exactly once, whatever state its run is in.
     */
    executedAt: timestamp('executed_at', { withTimezone: true }),
    /** Recoverable worker claim. Expired leases are eligible for replay. */
    executionStatus: approvalExecutionStatus('execution_status').notNull().default('pending'),
    executionLeaseUntil: timestamp('execution_lease_until', { withTimezone: true }),
    executionAttempts: integer('execution_attempts').notNull().default(0),
    executionError: text('execution_error'),
    ...auditColumns,
  },
  (t) => [
    index('approvals_pending_idx').on(t.tenantId, t.status, t.createdAt),
    index('approvals_execution_idx').on(t.tenantId, t.executionStatus, t.executionLeaseUntil),
    uniqueIndex('approvals_pending_tool_call_key')
      .on(t.runId, sql`((${t.payload}->'action'->>'toolCallId'))`)
      .where(sql`${t.status} = 'pending' and (${t.payload}->'action'->>'toolCallId') is not null`),
  ],
)

export const GOVERNANCE_TENANT_TABLES = ['autonomy_settings', 'approvals'] as const
