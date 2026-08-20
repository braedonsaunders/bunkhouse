import { bigint, foreignKey, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, money, tenantRef } from '@braedonsaunders/appkit-db'

/**
 * A run is one unit of an agent's work — answering a thread, performing a duty,
 * acting on a delegation. Run events are the append-only record the observatory
 * replays and the audit trail approvals hang off.
 */
export const dutySchedule = pgEnum('duty_schedule_kind', ['cron', 'interval', 'once'])

/**
 * Where a standing deliverable ends up.
 *
 * Two axes, deliberately separate: the channel (`via`) and the identity. An
 * internal recipient is stored as a `personId` and resolved at send time, so a
 * colleague whose address changes keeps receiving their reports; a typed
 * address is stored verbatim because there is nothing behind it to resolve and
 * pretending otherwise would lose what the operator actually wrote.
 *
 * The alternative — recipients living in the instruction prose — is what this
 * replaces. "Email the report to the Owner" reads fine and is a guess the
 * model re-makes on every run.
 */
export type DeliveryTarget =
  | { via: 'email'; personId: string }
  | { via: 'email'; address: string; name?: string }
  | { via: 'chat'; personId: string }
  | { via: 'call'; personId: string }
  | { via: 'call'; number: string }

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
    /**
     * Who the work product goes to, and how. Empty means nothing is declared
     * and the instruction's own words stand — which is every duty written
     * before this existed, so adding the column changed no recipients.
     */
    deliverTo: jsonb('deliver_to').$type<DeliveryTarget[]>().notNull().default([]),
    /** Slug of the role's duty this was instantiated from, if any. */
    fromRolePackDuty: text('from_role_pack_duty'),
    /** Run in which an employee created this duty, preserving human-request provenance. */
    sourceRunId: uuid('source_run_id'),
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
  'waiting_credential',
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
  | { type: 'credential_followup'; requestId: string; originRunId: string }
  /**
   * Work a run started and intends to collect itself, rather than hand away.
   *
   * `subagent` runs as the SAME person on a narrower brief — it inherits that
   * agent's dials, abilities and budget, and is a way of doing several things
   * at once rather than a second actor. `invocation` runs as a DIFFERENT
   * person, one below the caller in the reporting tree, under their own
   * governance.
   *
   * The brief lives here rather than in the queue message on purpose: the run
   * row is created before the job is enqueued so the parent can list what it
   * launched immediately, and a brief that only existed in Redis would leave
   * that row running forever if the queue lost it.
   */
  | { type: 'subagent'; parentRunId: string; label: string; brief: string }
  | { type: 'invocation'; parentRunId: string; label: string; brief: string; byPersonId: string }

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
     * full context after its approval or awaited reply arrives. Written only
     * while the run is parked; cleared when it finishes.
     */
    transcript: jsonb('transcript').$type<unknown[]>(),
    /**
     * What a waiting_reply run is parked on: the thread the answer arrives on,
     * who was asked, and the nudge schedule. Cleared on resume.
     */
    waiting: jsonb('waiting').$type<{
      threadId: string
      to: string
      question: string
      nudgeAfterDays: number
      askedAt: string
      nudgedAt?: string
    }>(),
    /**
     * Inbound messages this run consumed by resuming on them — so the mailbox
     * pass never also starts a fresh run for the same message.
     */
    consumedMessageIds: uuid('consumed_message_ids').array().notNull().default([]),
    /**
     * The human ask this run descends from, or null when it IS the ask.
     *
     * A call, an inbound email, an operator pressing go: those are roots. Work
     * derived from one — an assignment it commits to, a colleague it delegates
     * to, that colleague's reply — carries the same root however far it
     * spreads. Without it there was no way to say what one request had cost,
     * and no way to stop it: four test phone calls produced nine hundred
     * assignments and the only thing that noticed was the invoice.
     */
    rootRunId: uuid('root_run_id'),
    /** Monotonic authority token. Every worker completion is fenced by it. */
    leaseFence: integer('lease_fence').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    activeAttemptId: uuid('active_attempt_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('runs_tenant_id_id_key').on(t.tenantId, t.id),
    index('runs_person_idx').on(t.tenantId, t.personId, t.startedAt),
  ],
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
  /**
   * Why something happened, rather than what happened: what caused an agent
   * utterance, what became of a piece of work handed over on a call, what the
   * delivery mailbox decided about a line and why. Its own kind rather than
   * another `message`, because a message is the agent's own prose and mixing
   * the two would leave one column meaning two things — and because the whole
   * point of the record is being able to read the operational story on its own,
   * or exclude it from the narrative surfaces that show an agent's work.
   */
  'trace',
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

/** One immutable execution attempt. State changes are facts in the event row below. */
export const runAttempts = pgTable(
  'run_attempts',
  {
    id: id(),
    tenantId: tenantRef(),
    runId: uuid('run_id').notNull(),
    owner: text('owner').notNull(),
    fence: integer('fence').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('run_attempts_run_fence_key').on(t.runId, t.fence),
    uniqueIndex('run_attempts_tenant_id_id_key').on(t.tenantId, t.id),
    index('run_attempts_run_idx').on(t.tenantId, t.runId, t.startedAt),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [runs.tenantId, runs.id],
      name: 'run_attempts_tenant_run_fk',
    }),
  ],
)

export type RunAttemptEventKind = 'claimed' | 'renewed' | 'completed' | 'failed' | 'cancelled' | 'lease_lost'

/** Append-only lifecycle evidence for one attempt; renewals never rewrite history. */
export const runAttemptEvents = pgTable(
  'run_attempt_events',
  {
    id: id(),
    tenantId: tenantRef(),
    attemptId: uuid('attempt_id').notNull(),
    seq: integer('seq').notNull(),
    kind: text('kind').$type<RunAttemptEventKind>().notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('run_attempt_events_seq_key').on(t.attemptId, t.seq),
    index('run_attempt_events_attempt_idx').on(t.tenantId, t.attemptId),
    foreignKey({
      columns: [t.tenantId, t.attemptId],
      foreignColumns: [runAttempts.tenantId, runAttempts.id],
      name: 'run_attempt_events_tenant_attempt_fk',
    }),
  ],
)

/** Immutable declaration of an action that may change a system outside the run. */
export const externalEffectIntents = pgTable(
  'external_effect_intents',
  {
    id: id(),
    tenantId: tenantRef(),
    runId: uuid('run_id').notNull(),
    /** Which immutable authority `attemptId` names; enforced by a database trigger. */
    provenanceKind: text('provenance_kind').$type<'run_attempt' | 'approval'>().notNull(),
    attemptId: uuid('attempt_id').notNull(),
    kind: text('kind').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    request: jsonb('request').$type<unknown>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('external_effect_intents_key').on(t.tenantId, t.idempotencyKey),
    uniqueIndex('external_effect_intents_tenant_id_id_key').on(t.tenantId, t.id),
    index('external_effect_intents_run_idx').on(t.tenantId, t.runId, t.createdAt),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [runs.tenantId, runs.id],
      name: 'external_effect_intents_tenant_run_fk',
    }),
  ],
)

export type ExternalEffectEventKind = 'retry_started' | 'completed' | 'failed' | 'ambiguous' | 'reconciled'

/** Append-only outcomes and reconciliation evidence for one external intent. */
export const externalEffectEvents = pgTable(
  'external_effect_events',
  {
    id: id(),
    tenantId: tenantRef(),
    effectId: uuid('effect_id').notNull(),
    seq: integer('seq').notNull(),
    kind: text('kind').$type<ExternalEffectEventKind>().notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('external_effect_events_seq_key').on(t.effectId, t.seq),
    index('external_effect_events_effect_idx').on(t.tenantId, t.effectId),
    foreignKey({
      columns: [t.tenantId, t.effectId],
      foreignColumns: [externalEffectIntents.tenantId, externalEffectIntents.id],
      name: 'external_effect_events_tenant_effect_fk',
    }),
  ],
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
  | {
      kind: 'delegation'
      fromPersonId: string
      runId: string
      /**
       * How many colleagues this has already been passed between. A handoff a
       * colleague can return is a handoff two agents can bounce at each other
       * forever, so the chain carries its own length and stops itself.
       */
      hops?: number
      /** The human ask the whole chain descends from. */
      rootRunId?: string
    }

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
    /** Of inputTokens, the portion the provider served from its prompt cache. */
    cachedInputTokens: bigint('cached_input_tokens', { mode: 'number' }).notNull().default(0),
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

export const WORK_TENANT_TABLES = [
  'duties',
  'runs',
  'run_events',
  'run_attempts',
  'run_attempt_events',
  'external_effect_intents',
  'external_effect_events',
  'token_spend',
  'assignments',
] as const
