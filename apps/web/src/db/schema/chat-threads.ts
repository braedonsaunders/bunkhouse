import { sql } from 'drizzle-orm'
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@braedonsaunders/appkit-db'

/**
 * The in-app chat surface: one person, one agent, one conversation — held
 * beside a live view of that agent's desk.
 *
 * Kept apart from `schema/chat.ts` on purpose. That file is the Slack/Teams
 * BRIDGE's own plumbing (which agent answers which channel, and a dedupe
 * ledger so a retried delivery never starts two runs); the conversation itself
 * lives in Slack or Teams. These two tables are the conversation, for the one
 * surface that has nowhere else to keep it. Two different jobs, two files.
 *
 * Doctrine #1 holds either way: mail is primary, chat is secondary, and
 * neither is a parallel work system. A message here becomes exactly the run
 * `executeAgentRun` already produces for mail — trigger `{ type: 'chat' }`,
 * input `{ type: 'chat' }` — and `chat_messages.run_id` is the join back to
 * the runs/run_events ledger that did the work. Nothing an agent does is
 * recorded here; only what was said.
 */
export const chatThreadStatus = pgEnum('chat_thread_status', ['open', 'closed'])
export const chatMessageRole = pgEnum('chat_message_role', ['user', 'agent', 'system'])
export const chatDispatchStatus = pgEnum('chat_dispatch_status', [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
])
export const chatDispatchEventKind = pgEnum('chat_dispatch_event_kind', [
  'queued',
  'claimed',
  'run_linked',
  'completed',
  'failed',
  'retried',
  'edited',
  'cancelled',
])

/**
 * A conversation between one signed-in human and one agent. Mutable by
 * design — the title is derived once from the opening message, `lastMessageAt`
 * moves as the conversation does, and status opens and closes. None of that
 * reinterprets history; the history is in `chat_messages`.
 */
export const chatThreads = pgTable(
  'chat_threads',
  {
    id: id(),
    tenantId: tenantRef(),
    /** The AGENT being talked to. */
    personId: uuid('person_id').notNull(),
    /** The human doing the talking — the workspace login (identity `users.id`). */
    userId: uuid('user_id').notNull(),
    /** Derived from the first message, so the list reads as a list of topics. */
    title: text('title'),
    /** Immutable provenance for "Continue in new conversation". The child
     * receives context through this message but keeps its own transcript and
     * governed run identity from that point forward. */
    originThreadId: uuid('origin_thread_id'),
    originMessageSeq: integer('origin_message_seq'),
    status: chatThreadStatus('status').notNull().default('open'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [
    index('chat_threads_user_idx').on(t.tenantId, t.userId, t.lastMessageAt),
    index('chat_threads_person_idx').on(t.tenantId, t.personId),
    index('chat_threads_origin_idx').on(t.tenantId, t.originThreadId),
  ],
)

/**
 * What was said, append-only at the database boundary
 * (`reject_immutable_ledger_change`, migration 0047). A correction is a new
 * message, never an edit — the same rule the run, mail and desk ledgers keep.
 *
 * `seq` is unique per thread and allocated under a per-thread advisory lock,
 * so two turns posted at the same instant can neither collide nor reorder.
 * `runId` is the run this message produced (on a user turn) or came from (on
 * an agent turn) — the join back to the work.
 */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: id(),
    tenantId: tenantRef(),
    threadId: uuid('thread_id').notNull(),
    seq: integer('seq').notNull(),
    role: chatMessageRole('role').notNull(),
    body: text('body').notNull(),
    runId: uuid('run_id'),
    dispatchId: uuid('dispatch_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chat_messages_seq_key').on(t.threadId, t.seq),
    index('chat_messages_thread_idx').on(t.tenantId, t.threadId),
    index('chat_messages_run_idx').on(t.tenantId, t.runId),
    index('chat_messages_dispatch_idx').on(t.tenantId, t.dispatchId),
    uniqueIndex('chat_messages_dispatch_user_key')
      .on(t.dispatchId)
      .where(sql`${t.role} = 'user' and ${t.dispatchId} is not null`),
  ],
)

/**
 * Durable intent to say something in a conversation. The row is the current
 * projection used for claiming; `chat_dispatch_events` is the append-only
 * evidence for every transition and edit.
 *
 * `position` never changes. Completed and cancelled rows stay in place, so a
 * later retry cannot reinterpret which message was ahead of which. A partial
 * unique index allows at most one running dispatch per thread even when two
 * workers race in different processes.
 */
export const chatDispatches = pgTable(
  'chat_dispatches',
  {
    id: id(),
    tenantId: tenantRef(),
    threadId: uuid('thread_id').notNull(),
    userId: uuid('user_id').notNull(),
    position: integer('position').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    body: text('body').notNull(),
    status: chatDispatchStatus('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    runId: uuid('run_id'),
    lastError: text('last_error'),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('chat_dispatches_idempotency_key').on(t.threadId, t.idempotencyKey),
    uniqueIndex('chat_dispatches_position_key').on(t.threadId, t.position),
    uniqueIndex('chat_dispatches_one_running_key')
      .on(t.threadId)
      .where(sql`${t.status} = 'running'`),
    index('chat_dispatches_pending_idx').on(t.tenantId, t.threadId, t.position),
    index('chat_dispatches_run_idx').on(t.tenantId, t.runId),
  ],
)

/** Immutable lifecycle evidence for the mutable dispatch projection. */
export const chatDispatchEvents = pgTable(
  'chat_dispatch_events',
  {
    id: id(),
    tenantId: tenantRef(),
    dispatchId: uuid('dispatch_id').notNull(),
    seq: integer('seq').notNull(),
    kind: chatDispatchEventKind('kind').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    actorId: uuid('actor_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chat_dispatch_events_seq_key').on(t.dispatchId, t.seq),
    index('chat_dispatch_events_tenant_idx').on(t.tenantId, t.dispatchId, t.seq),
  ],
)

export const CHAT_THREAD_TENANT_TABLES = [
  'chat_threads',
  'chat_messages',
  'chat_dispatches',
  'chat_dispatch_events',
] as const
