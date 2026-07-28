import { bigint, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, money, tenantRef } from '@appkit/db'

/**
 * The call ledger. Every voice conversation with an agent is a call_sessions
 * row (one LiveKit room) plus an append-only transcript in call_turns —
 * the same shape as the mail ledger: the session is the thread, the turns
 * are the messages. Calls also create a run, so they surface in the
 * observatory next to everything else the agent does.
 */
export const callDirection = pgEnum('call_direction', ['web', 'inbound_phone', 'outbound_phone'])
export const callSessionStatus = pgEnum('call_session_status', ['active', 'ended', 'failed'])

/** Who is on the other end of the line. Web calls carry a LiveKit identity;
 *  phone calls (later slices) carry an E.164 number. */
export type CallCounterparty = {
  name?: string
  identity?: string
  number?: string
}

export const callSessions = pgTable(
  'call_sessions',
  {
    id: id(),
    tenantId: tenantRef(),
    /** The agent on the call. */
    personId: uuid('person_id').notNull(),
    /** The run this call is recorded under (null only if run creation failed). */
    runId: uuid('run_id'),
    /** LiveKit room name — `call-{sessionId}`; the voice agent joins by it. */
    room: text('room').notNull(),
    direction: callDirection('direction').notNull(),
    counterparty: jsonb('counterparty').$type<CallCounterparty>().notNull(),
    status: callSessionStatus('status').notNull().default('active'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationSeconds: integer('duration_seconds'),
    /** Speech/model spend for the call; null when the framework exposed no usage. */
    costUsd: money('cost_usd'),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('call_sessions_room_key').on(t.room),
    index('call_sessions_person_idx').on(t.tenantId, t.personId, t.startedAt),
    index('call_sessions_run_idx').on(t.tenantId, t.runId),
  ],
)

export const callSpeaker = pgEnum('call_speaker', ['agent', 'human'])

/** Append-only transcript ledger — rows are only ever inserted, never updated. */
export const callTurns = pgTable(
  'call_turns',
  {
    id: id(),
    tenantId: tenantRef(),
    sessionId: uuid('session_id').notNull(),
    seq: integer('seq').notNull(),
    speaker: callSpeaker('speaker').notNull(),
    text: text('text').notNull(),
    /** Offset from the session's startedAt, milliseconds. */
    atMs: bigint('at_ms', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('call_turns_seq_key').on(t.sessionId, t.seq),
    index('call_turns_session_idx').on(t.tenantId, t.sessionId),
  ],
)

export const VOICE_TENANT_TABLES = ['call_sessions', 'call_turns'] as const
