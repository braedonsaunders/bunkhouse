import { boolean, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@appkit/db'

/**
 * The workspace: each agent has a persistent home directory (its desk) and
 * runs shell work inside a bubblewrap sandbox bound to it. Every command is a
 * recorded, replayable session — doctrine: gated abilities leave evidence.
 * Append-only; output is captured (capped) at execution time.
 */
export const shellSessionStatus = pgEnum('shell_session_status', ['completed', 'failed', 'timeout'])

export const shellSessions = pgTable(
  'shell_sessions',
  {
    id: id(),
    tenantId: tenantRef(),
    personId: uuid('person_id').notNull(),
    runId: uuid('run_id'),
    /** Stable AppKit supervisor identity used to correlate transport retries. */
    executionId: text('execution_id'),
    command: text('command').notNull(),
    /** Working directory inside the sandbox, relative to the agent's home. */
    cwd: text('cwd').notNull().default('.'),
    status: shellSessionStatus('status').notNull(),
    exitCode: integer('exit_code'),
    /** Combined stdout+stderr, capped — the replayable record. */
    output: text('output').notNull(),
    outputTruncated: boolean('output_truncated').notNull().default(false),
    durationMs: integer('duration_ms').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    index('shell_sessions_person_idx').on(t.tenantId, t.personId, t.startedAt),
    index('shell_sessions_run_idx').on(t.tenantId, t.runId),
    uniqueIndex('shell_sessions_execution_idx').on(t.tenantId, t.executionId),
  ],
)

export const WORKSPACE_TENANT_TABLES = ['shell_sessions'] as const
