import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@appkit/db'

/**
 * The desk ledger (docs/agent-desk.md §3.19): one session per lease, one
 * append-only typed event stream. On a desk the agent types in a terminal and
 * clicks in a GUI as one continuous piece of work, so this is ONE ledger — an
 * operator replays a session end to end rather than interleaving three tables
 * by timestamp. It supersedes browser_sessions/browser_steps/shell_sessions
 * for new writes; those tables keep their historical rows as audit history.
 *
 * Because per-command approval moved off the agent path (§3.22), this ledger
 * carries more of the governance weight than the ones it replaces. Events are
 * immutable at the database boundary (reject_immutable_ledger_change).
 */
export const deskSessionStatus = pgEnum('desk_session_status', ['active', 'ended', 'failed'])
export const deskJobStatus = pgEnum('desk_job_status', ['running', 'exited', 'killed'])

export const deskSessions = pgTable(
  'desk_sessions',
  {
    id: id(),
    tenantId: tenantRef(),
    /** The agent at the desk. */
    personId: uuid('person_id').notNull(),
    /** The run this lease serves — one active session per run, like the browser had. */
    runId: uuid('run_id').notNull(),
    status: deskSessionStatus('status').notNull().default('active'),
    /** When (and why) the expensive tier was entered. Null while headless. */
    screenOpenedAt: timestamp('screen_opened_at', { withTimezone: true }),
    /** The agent's stated justification for opening a screen — §3.17. */
    screenReason: text('screen_reason'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    index('desk_sessions_run_idx').on(t.tenantId, t.runId),
    index('desk_sessions_person_idx').on(t.tenantId, t.personId, t.startedAt),
  ],
)

/**
 * The seed taxonomy for desk events — the spec's list (§6.1) plus the kinds
 * the in-guest browser writes when its steps land on this same ledger (§3.19:
 * one stream, not a separate browser table). The column itself is text, not a
 * pg enum, because this list grows with the desk and a ledger must never
 * refuse a row because the taxonomy moved first.
 *
 * NOTE: run-activity.tsx already has a UI type named `DeskEvent` meaning "run
 * desk event row" — these are deliberately `DeskLedger*` to avoid colliding.
 */
export type DeskLedgerEventKind =
  | 'shell_command'
  | 'app_launch'
  | 'click'
  /** A bare pointer move — only an operator driving by hand produces these. */
  | 'move'
  | 'type'
  | 'key'
  | 'scroll'
  | 'drag'
  | 'window_focus'
  | 'screen_open'
  | 'screen_close'
  | 'file_write'
  | 'shared_write'
  | 'egress_blocked'
  | 'handover_begin'
  | 'handover_end'
  | 'job_start'
  | 'job_exit'
  // The browser rides the same ledger: its steps land as these kinds.
  | 'navigate'
  | 'read'
  | 'screenshot'
  | 'browser_close'

/**
 * What an event carried beyond its kind — the generalization of the browser
 * step's detail to the whole desk. Every field is optional because every kind
 * uses a different slice; the kind says which slice to expect.
 */
export type DeskLedgerEventDetail = {
  // Pages and navigation (browser kinds).
  url?: string
  title?: string
  /** HTTP status of a navigation, when the step navigated. */
  status?: number
  /** The link/button text or field the agent aimed at. */
  target?: string
  /** Typed text, as sent — replaced with a marker when the field is a password. */
  text?: string
  // The terminal.
  command?: string
  cwd?: string
  exitCode?: number | null
  signal?: string | null
  /** Combined stdout+stderr, capped at record time. */
  output?: string
  outputTruncated?: boolean
  // The screen: coordinates in observe() pixel space, 1:1.
  x?: number
  y?: number
  button?: 'left' | 'middle' | 'right'
  combo?: string
  dx?: number
  dy?: number
  from?: { x: number; y: number }
  to?: { x: number; y: number }
  appId?: string
  args?: string[]
  window?: { id: string; title: string; appId: string | null }
  width?: number
  height?: number
  /** The stated justification recorded with screen_open (§3.17). */
  reason?: string
  // Handovers: boundaries only — never content (§3.14).
  actor?: string | null
  scope?: 'view' | 'control'
  durationMs?: number
  // Background jobs.
  jobId?: string
  // Egress denials.
  host?: string | null
  port?: number | null
  /** Why a step could not be carried out. */
  error?: string
  /** Set when the screenshot itself failed, so a null file id is explained. */
  screenshotError?: string
}

/** Append-only: one row per governed thing that happened on the desk. */
export const deskEvents = pgTable(
  'desk_events',
  {
    id: id(),
    tenantId: tenantRef(),
    sessionId: uuid('session_id').notNull(),
    seq: integer('seq').notNull(),
    /** Text, not an enum — see DeskLedgerEventKind. */
    kind: text('kind').$type<DeskLedgerEventKind>().notNull(),
    detail: jsonb('detail').$type<DeskLedgerEventDetail>().notNull(),
    /** The frame captured with this event, in the files ledger. */
    screenshotFileId: uuid('screenshot_file_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('desk_events_seq_key').on(t.sessionId, t.seq),
    index('desk_events_session_idx').on(t.tenantId, t.sessionId),
  ],
)

/**
 * Processes that outlive a command (keepAlive jobs). A running process nobody
 * can see is the failure mode here: an operator must be able to find and kill
 * a daemon, so job starts and exits are mirrored from the event stream into a
 * queryable table with a live status column.
 */
export const backgroundJobs = pgTable(
  'background_jobs',
  {
    id: id(),
    tenantId: tenantRef(),
    personId: uuid('person_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    /** The runner's job handle — what a kill request names. */
    jobId: text('job_id').notNull(),
    command: text('command').notNull(),
    status: deskJobStatus('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    exitedAt: timestamp('exited_at', { withTimezone: true }),
    exitCode: integer('exit_code'),
    ...auditColumns,
  },
  (t) => [
    index('background_jobs_open_idx').on(t.tenantId, t.status, t.startedAt),
    uniqueIndex('background_jobs_job_key').on(t.sessionId, t.jobId),
  ],
)

export const DESK_TENANT_TABLES = ['desk_sessions', 'desk_events', 'background_jobs'] as const
