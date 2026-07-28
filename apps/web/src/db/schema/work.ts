import { bigint, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, money, tenantRef } from '@appkit/db'

/**
 * A run is one unit of a hand's work — answering a thread, performing a duty,
 * acting on a delegation. Run events are the append-only record the observatory
 * replays and the audit trail approvals hang off.
 */
export const dutySchedule = pgEnum('duty_schedule_kind', ['cron', 'interval'])

export const duties = pgTable(
  'duties',
  {
    id: id(),
    tenantId: tenantRef(),
    personId: uuid('person_id').notNull(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    /** What to do, in the hand's own terms — becomes the run's instruction. */
    instruction: text('instruction').notNull(),
    scheduleKind: dutySchedule('schedule_kind').notNull(),
    /** Cron expression, or interval minutes as a decimal string. */
    schedule: text('schedule').notNull(),
    /** Slug of the role-pack duty this was instantiated from, if any. */
    fromRolePackDuty: text('from_role_pack_duty'),
    enabled: text('enabled').$type<'on' | 'off'>().notNull().default('on'),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextDueAt: timestamp('next_due_at', { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('duties_person_slug_key').on(t.tenantId, t.personId, t.slug),
    index('duties_due_idx').on(t.tenantId, t.nextDueAt),
  ],
)

export const runStatus = pgEnum('run_status', [
  'running',
  'waiting_approval',
  'waiting_reply',
  'completed',
  'failed',
  'cancelled',
])

export type RunTrigger =
  | { type: 'email'; threadId: string; messageId: string }
  | { type: 'duty'; dutyId: string }
  | { type: 'chat'; conversationId: string }
  | { type: 'delegation'; fromPersonId: string; runId: string }
  | { type: 'manual'; requestedBy: string }

export const runs = pgTable(
  'runs',
  {
    id: id(),
    tenantId: tenantRef(),
    personId: uuid('person_id').notNull(),
    status: runStatus('status').notNull().default('running'),
    trigger: jsonb('trigger').$type<RunTrigger>().notNull(),
    /** One-line human summary of what the run did; shown in the activity feed. */
    summary: text('summary'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [index('runs_person_idx').on(t.tenantId, t.personId, t.startedAt)],
)

export const runEventKind = pgEnum('run_event_kind', [
  'thought',
  'message',
  'tool_call',
  'tool_result',
  'procedure_citation',
  'approval_request',
  'delegation',
  'error',
])

export const runEvents = pgTable(
  'run_events',
  {
    id: id(),
    tenantId: tenantRef(),
    runId: uuid('run_id').notNull(),
    seq: integer('seq').notNull(),
    kind: runEventKind('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('run_events_seq_key').on(t.runId, t.seq)],
)

/** One ledger row per model call; the salary/overtime meter aggregates this. */
export const tokenSpend = pgTable(
  'token_spend',
  {
    id: id(),
    tenantId: tenantRef(),
    personId: uuid('person_id').notNull(),
    runId: uuid('run_id').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull(),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull(),
    costUsd: money('cost_usd').notNull(),
    /** The exact price applied, stamped at spend time for audit. */
    inputUsdPerMtok: money('input_usd_per_mtok'),
    outputUsdPerMtok: money('output_usd_per_mtok'),
    /** 'openrouter' | 'manual' | 'unpriced' — how the cost was derived. */
    priceSource: text('price_source'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('token_spend_person_idx').on(t.tenantId, t.personId, t.createdAt)],
)

export const WORK_TENANT_TABLES = ['duties', 'runs', 'run_events', 'token_spend'] as const
