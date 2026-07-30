import { boolean, index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@appkit/db'

/**
 * Every agent's primary surface is a real mailbox on the company's own domain.
 * Secrets (OAuth refresh tokens, IMAP passwords) are NEVER stored here — only a
 * reference into the secret store; this schema stays safe to dump/clone.
 */
export const mailboxProvider = pgEnum('mailbox_provider', ['gmail', 'microsoft', 'imap'])
export const mailboxStatus = pgEnum('mailbox_status', ['connecting', 'active', 'error', 'disabled'])

export type ImapEndpoints = {
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  /** STARTTLS vs implicit TLS per endpoint. */
  imapSecure: boolean
  smtpSecure: boolean
  username: string
}

export const mailboxAccounts = pgTable(
  'mailbox_accounts',
  {
    id: id(),
    tenantId: tenantRef(),
    personId: uuid('person_id').notNull(),
    address: text('address').notNull(),
    provider: mailboxProvider('provider').notNull(),
    status: mailboxStatus('status').notNull().default('connecting'),
    /** IMAP/SMTP endpoints; null for gmail/microsoft (API-based). */
    imap: jsonb('imap').$type<ImapEndpoints>(),
    /** Opaque reference into the secret store for this account's credentials. */
    secretRef: text('secret_ref').notNull(),
    /** Provider-specific incremental sync position (historyId, delta link, UIDVALIDITY/UID). */
    syncCursor: jsonb('sync_cursor').$type<Record<string, unknown>>(),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('mailbox_accounts_tenant_address_key').on(t.tenantId, t.address),
    index('mailbox_accounts_person_idx').on(t.tenantId, t.personId),
  ],
)

export type MailParticipant = { name?: string; address: string }

export const mailThreads = pgTable(
  'mail_threads',
  {
    id: id(),
    tenantId: tenantRef(),
    mailboxId: uuid('mailbox_id').notNull(),
    subject: text('subject').notNull(),
    /** Provider thread key (Gmail threadId, Graph conversationId) or our RFC-5322 chain root. */
    externalThreadKey: text('external_thread_key'),
    participants: jsonb('participants').$type<MailParticipant[]>().notNull().default([]),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull(),
    /** Open threads are actionable inbox items for the owning agent. */
    open: boolean('open').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index('mail_threads_mailbox_idx').on(t.tenantId, t.mailboxId, t.lastMessageAt),
    uniqueIndex('mail_threads_external_key').on(t.mailboxId, t.externalThreadKey),
  ],
)

export const mailDirection = pgEnum('mail_direction', ['inbound', 'outbound'])

export type MailAttachmentRef = {
  /** File id in @appkit/storage. */
  fileId: string
  filename: string
  contentType: string
  size: number
}

export const mailMessages = pgTable(
  'mail_messages',
  {
    id: id(),
    tenantId: tenantRef(),
    threadId: uuid('thread_id').notNull(),
    direction: mailDirection('direction').notNull(),
    from: jsonb('from').$type<MailParticipant>().notNull(),
    to: jsonb('to').$type<MailParticipant[]>().notNull().default([]),
    cc: jsonb('cc').$type<MailParticipant[]>().notNull().default([]),
    subject: text('subject').notNull(),
    bodyText: text('body_text').notNull(),
    bodyHtml: text('body_html'),
    /** RFC 5322 Message-ID; dedupe key for inbound sync. */
    externalMessageId: text('external_message_id'),
    attachments: jsonb('attachments').$type<MailAttachmentRef[]>().notNull().default([]),
    /** Outbound only: the run that produced this message (audit anchor). */
    runId: uuid('run_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    ...auditColumns,
  },
  (t) => [
    index('mail_messages_thread_idx').on(t.tenantId, t.threadId, t.sentAt),
    uniqueIndex('mail_messages_external_id_key').on(t.threadId, t.externalMessageId),
  ],
)

export const colleagueMessages = pgTable(
  'colleague_messages',
  {
    id: id(),
    tenantId: tenantRef(),
    fromPersonId: uuid('from_person_id').notNull(),
    toPersonId: uuid('to_person_id').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    /** The run that sent it — the audit anchor back to why it was said. */
    runId: uuid('run_id'),
    /**
     * The human ask this descends from. Every derived thing carries it, so the
     * cost of one request can be totalled and bounded however far the work
     * spreads.
     */
    rootRunId: uuid('root_run_id'),
    readAt: timestamp('read_at', { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    index('colleague_messages_inbox_idx').on(t.tenantId, t.toPersonId, t.readAt),
    index('colleague_messages_root_idx').on(t.tenantId, t.rootRunId),
  ],
)

export const MAIL_TENANT_TABLES = [
  'mailbox_accounts',
  'mail_threads',
  'mail_messages',
  'colleague_messages',
] as const

/**
 * An internal message between colleagues — the inbox, not the logbook.
 *
 * Two agents at one company need to be able to say something to each other
 * without it becoming a job, and without it becoming a memory. Both of those
 * were tried and both were wrong:
 *
 * - as an assignment, every message was a full model run, so an
 *   acknowledgement cost as much as an hour of research. That is where
 *   `Re: Re: Re: Re: Daily check-in outcome` came from: hundreds of runs of
 *   agents thanking each other for thanking each other.
 * - as a note in the recipient's logbook it stopped costing runs but polluted
 *   the one place an agent keeps what it has LEARNED — competing for the
 *   retrieval budget, ageing through the gardener, and being weighed for
 *   importance alongside real facts. A message is not a lesson.
 *
 * So it is its own thing, with the one property that matters: it waits. The
 * recipient reads it next time they are working, whatever started them, and it
 * is marked read when they do.
 */
