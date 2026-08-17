import { sql } from 'drizzle-orm'
import { bigint, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, money, tenantRef } from '@braedonsaunders/appkit-db'
import type { AgentVoiceConfig } from '@braedonsaunders/appkit-voice'

/**
 * The call ledger. Every voice conversation with an agent is a call_sessions
 * row (one LiveKit room) plus an append-only transcript in call_turns —
 * the same shape as the mail ledger: the session is the thread, the turns
 * are the messages. Calls also create a run, so they surface in the
 * observatory next to everything else the agent does.
 */
export const callDirection = pgEnum('call_direction', ['web', 'inbound_phone', 'outbound_phone'])
export const callSessionStatus = pgEnum('call_session_status', ['active', 'ended', 'failed'])

/** What sort of line the other end was on: a public telephone number, an
 *  extension on the company phone system, or a browser. */
export const callPeerKind = pgEnum('call_peer_kind', ['pstn', 'pbx_extension', 'web'])

/** Who is on the other end of the line. Web calls carry a LiveKit identity and
 *  the signed-in caller's email (the default recipient for work taken on the
 *  call); phone calls carry an E.164 number. */
export type CallCounterparty = {
  name?: string
  identity?: string
  number?: string
  email?: string
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
    /** Why the agent placed this call — the briefing it opens with. Outbound
     *  only; on inbound and web calls the caller states their own business. */
    purpose: text('purpose'),
    status: callSessionStatus('status').notNull().default('active'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationSeconds: integer('duration_seconds'),
    /** Speech/model spend for the call; null when the framework exposed no usage. */
    costUsd: money('cost_usd'),
    /** The line the peer was on. Null means the writer did not classify the
     *  call — never inferred after the fact. */
    peerKind: callPeerKind('peer_kind'),
    /** The phone-system extension involved: the extension dialled on an
     *  inbound PBX call, or the one dialled out to. Null off the PBX. */
    peerExtension: text('peer_extension'),
    /** The call's audio recording in the files ledger. Null when recording was
     *  unavailable, failed, or the retention sweep has since removed it — the
     *  column and the file row are cleared together, never left dangling. */
    recordingFileId: uuid('recording_file_id'),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('call_sessions_room_key').on(t.room),
    index('call_sessions_person_idx').on(t.tenantId, t.personId, t.startedAt),
    index('call_sessions_run_idx').on(t.tenantId, t.runId),
    // The retention sweep walks recordings by age; only rows that still hold
    // one are of interest, so the index carries only those.
    index('call_sessions_recording_idx')
      .on(t.tenantId, t.startedAt)
      .where(sql`${t.recordingFileId} is not null`),
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

/**
 * A guest's way into a video meeting: one unguessable token per session,
 * mailed out by the agent. The link IS the credential — a guest needs no
 * account and no software, just the URL — so it is short-lived and single
 * meeting, and its use is stamped on the row the moment someone joins.
 */
export const meetingLinks = pgTable(
  'meeting_links',
  {
    id: id(),
    tenantId: tenantRef(),
    /** The call session (room `meet-{sessionId}`) this link opens. */
    sessionId: uuid('session_id').notNull(),
    /** URL-safe random secret; the /meet/[token] path segment. */
    token: text('token').notNull(),
    /** The agent that set the meeting up. */
    createdByPersonId: uuid('created_by_person_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** When the guest first joined; null while the invitation is outstanding. */
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('meeting_links_token_key').on(t.token),
    uniqueIndex('meeting_links_session_key').on(t.sessionId),
    index('meeting_links_person_idx').on(t.tenantId, t.createdByPersonId, t.createdAt),
  ],
)

/**
 * The agent's voice configuration as bunkhouse stores it: the portable
 * @braedonsaunders/appkit-voice contract plus the settings that only mean something inside
 * this product. Extra keys ride along in the same jsonb column, so an older
 * row simply has them undefined.
 */
export type BunkhouseVoiceConfig = AgentVoiceConfig & {
  /**
   * Retired: seeing a screen was once an operator's switch, on the theory that
   * only they could know whether the agent's model takes images. They cannot —
   * nobody can, without offering one — and the runtime already handles the
   * answer, switching vision off for the session and saying so out loud when a
   * model refuses. Stored values are ignored; the field remains only so an
   * older row still parses.
   *
   * @deprecated Vision is attempted on every call and meeting.
   */
  cascadeVision?: boolean
}

/** settings key: 'voice.retention' — how long call recordings are kept.
 *  `recordingDays: null` means keep them forever (the default: nothing is
 *  ever deleted unless an operator turns retention on). */
export type VoiceRetentionSettings = {
  recordingDays: number | null
}

export const VOICE_RETENTION_KEY = 'voice.retention'

/**
 * A rate read off a provider's own billing API rather than typed in: what the
 * company was charged over a window, divided by the minutes it bought. Kept
 * beside the operator's figure rather than replacing it, so a measurement can
 * never quietly overwrite a negotiated rate somebody entered on purpose.
 */
export type MeasuredVoiceRate = {
  usdPerMinute: number
  /** The billing window measured, `YYYY-MM-DD…YYYY-MM-DD`. */
  window: string
  /** When the measurement was taken, ISO 8601. */
  observedAt: string
}

/**
 * settings key: 'voice.pricing' — what a minute of speech costs THIS company.
 *
 * Two sources, in that order of authority: the rate an operator entered from
 * the company's own agreement, and the rate measured from the provider's
 * billing API. The typed figure always wins — a contract an operator knows
 * about beats an average taken over last month's invoices. Where neither
 * exists the price is not guessed: the minutes are still recorded, the money
 * simply is not claimed.
 */
export type VoicePricingSettings = {
  /** Deepgram streaming transcription, USD per minute of call. */
  deepgramUsdPerMinute?: number
  /** ElevenLabs speech synthesis, USD per minute of call. */
  elevenLabsUsdPerMinute?: number
  /** Speech-to-speech (OpenAI Realtime, Gemini Live), USD per minute of call. */
  realtimeUsdPerMinute?: number
  /**
   * Rates measured from a provider's billing API. Only Deepgram reports what
   * it charged; ElevenLabs meters in credits whose dollar value depends on the
   * plan, and realtime speech is billed as model tokens, so neither can be
   * measured this way and both stay operator-entered.
   */
  measured?: {
    deepgram?: MeasuredVoiceRate
  }
}

export const VOICE_PRICING_KEY = 'voice.pricing'

export const VOICE_TENANT_TABLES = ['call_sessions', 'call_turns', 'meeting_links'] as const
