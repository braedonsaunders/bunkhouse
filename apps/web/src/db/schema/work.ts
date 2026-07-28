import { bigint, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, money, tenantRef } from '@appkit/db'

/**
 * A run is one unit of an agent's work — answering a thread, performing a duty,
 * acting on a delegation. Run events are the append-only record the observatory
 * replays and the audit trail approvals hang off.
 */
export const dutySchedule = pgEnum('duty_schedule_kind', ['cron', 'interval', 'once'])

export const duties = pgTable(
  'duties',
  {
    id: id(),
    tenantId: tenantRef(),
    personId: uuid('person_id').notNull(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    /** What to do, in the agent's own terms — becomes the run's instruction. */
    instruction: text('instruction').notNull(),
    scheduleKind: dutySchedule('schedule_kind').notNull(),
    /** Cron expression, interval minutes as a decimal string, or — for `once`
     *  — the ISO instant of the single occurrence. */
    schedule: text('schedule').notNull(),
    /** IANA zone the pattern resolves in, defaulted from the agent at authoring
     *  time; null resolves in the worker's zone. Unused by `once`, which
     *  stores an absolute instant. */
    timezone: text('timezone'),
    /** Bounds on a recurrence: not before, not after, at most N times. */
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    maxRuns: integer('max_runs'),
    runCount: integer('run_count').notNull().default(0),
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
  | { type: 'assignment'; assignmentId: string }
  | { type: 'approval_followup'; approvalId: string; originRunId: string }

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
    /**
     * The model-message transcript at suspension, so the run can resume with
     * full context after its approval is decided. Written only when the run
     * parks (waiting_approval); cleared when it finishes.
     */
    transcript: jsonb('transcript').$type<unknown[]>(),
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

/**
 * A commitment to a deliverable: work an agent has taken on — from a call, a
 * mail thread, or an operator — with a recipient and (optionally) a deadline.
 * Distinct from duties: a duty is a schedule; an assignment is one finished
 * piece of work. The worker turns pending assignments into background runs.
 */
export const assignmentStatus = pgEnum('assignment_status', [
  'pending',
  'working',
  'waiting_approval',
  'delivered',
  'failed',
  'cancelled',
])

export type AssignmentSource =
  | { kind: 'call'; sessionId: string }
  | { kind: 'mail'; threadId: string }
  | { kind: 'manual'; requestedBy?: string }

export const assignments = pgTable(
  'assignments',
  {
    id: id(),
    tenantId: tenantRef(),
    /** The agent that owns the deliverable. */
    personId: uuid('person_id').notNull(),
    /** Where the commitment was made — the audit anchor back to a call or thread. */
    source: jsonb('source').$type<AssignmentSource>().notNull(),
    title: text('title').notNull(),
    /** What was asked for, in full — becomes the background run's instruction. */
    spec: text('spec').notNull(),
    /** Requested deliverable formats, informational: pdf, docx, xlsx… */
    formats: text('formats').array().notNull().default([]),
    deliverTo: jsonb('deliver_to').$type<{ name?: string; address: string }>().notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }),
    status: assignmentStatus('status').notNull().default('pending'),
    /** The background run doing (or that did) the work. */
    runId: uuid('run_id'),
    /** Files ledgered by the run — the finished work product. */
    resultFileIds: uuid('result_file_ids').array().notNull().default([]),
    lastError: text('last_error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    index('assignments_person_idx').on(t.tenantId, t.personId, t.createdAt),
    index('assignments_status_idx').on(t.tenantId, t.status, t.createdAt),
  ],
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

export const WORK_TENANT_TABLES = ['duties', 'runs', 'run_events', 'token_spend', 'assignments'] as const
