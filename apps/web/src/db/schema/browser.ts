import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@appkit/db'

/**
 * Computer use: an agent driving a real headless browser. One session per run
 * (browser_sessions) with an append-only step ledger (browser_steps) — the same
 * shape as the call ledger: the session is the visit, the steps are what
 * happened, in order.
 *
 * Doctrine: gated abilities are recorded. Every step carries a screenshot in
 * the files ledger, so an operator can replay the whole visit frame by frame.
 * Rows are only ever inserted; a session is closed by stamping ended_at.
 */
export const browserSessionStatus = pgEnum('browser_session_status', ['active', 'ended', 'failed'])

export const browserSessions = pgTable(
  'browser_sessions',
  {
    id: id(),
    tenantId: tenantRef(),
    /** The agent at the keyboard. */
    personId: uuid('person_id').notNull(),
    /** The run the visit belongs to — one browser per run, always. */
    runId: uuid('run_id').notNull(),
    status: browserSessionStatus('status').notNull().default('active'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    index('browser_sessions_run_idx').on(t.tenantId, t.runId),
    index('browser_sessions_person_idx').on(t.tenantId, t.personId, t.startedAt),
  ],
)

/** What the step did beyond its verb — the target, the page it settled on. */
export type BrowserStepDetail = {
  /** The page the step ended on. */
  url?: string
  title?: string
  /** HTTP status of the navigation, when the step navigated. */
  status?: number
  /** The link/button text or field the agent aimed at. */
  target?: string
  /** Typed text, as sent — replaced with a marker when the field is a password. */
  text?: string
  /** Why a step could not be carried out. */
  error?: string
  /** Set when the screenshot itself failed, so a null file id is explained. */
  screenshotError?: string
}

/** Append-only: one row per action the agent took in the browser. */
export const browserSteps = pgTable(
  'browser_steps',
  {
    id: id(),
    tenantId: tenantRef(),
    sessionId: uuid('session_id').notNull(),
    seq: integer('seq').notNull(),
    /** The verb: open, click, type, read, screenshot, close. */
    action: text('action').notNull(),
    detail: jsonb('detail').$type<BrowserStepDetail>().notNull(),
    /** The frame captured at this step, in the files ledger. */
    screenshotFileId: uuid('screenshot_file_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('browser_steps_seq_key').on(t.sessionId, t.seq),
    index('browser_steps_session_idx').on(t.tenantId, t.sessionId),
  ],
)

export const BROWSER_TENANT_TABLES = ['browser_sessions', 'browser_steps'] as const
