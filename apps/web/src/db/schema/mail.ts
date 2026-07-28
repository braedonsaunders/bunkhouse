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

export const MAIL_TENANT_TABLES = ['mailbox_accounts', 'mail_threads', 'mail_messages'] as const
