import 'server-only'
import { and, desc, eq, ne, sql } from 'drizzle-orm'
import { sealSecret, unsealSecret, type SealedSecret } from '@appkit/crypto'
import {
  sendMail,
  syncMailbox,
  verifyImap,
  verifySmtp,
  type ImapCursor,
  type MailboxConnection,
  type MailboxStore,
  type OutboundAttachment,
  type SendMailArgs,
} from '@appkit/mailbox'
import { mailboxAccounts, mailMessages, mailThreads, people, type MailAttachmentRef } from '../db/schema'
import { db } from '../db/client'
import { getFileBytes, getFileRecords, saveFile } from './files'
import { freshAccessToken, mailOauthProviderOf, recordMailboxError } from './mail-oauth'
import { loadSignatureContext, outboundHtmlBody, outboundTextBody, renderSignature } from './mail-signature'

/** Attachments above this size are left in the mailbox, referenced but not ledgered. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/**
 * Resolve ledgered files into wire attachments + the ledger refs for the
 * outbound message row. Unknown ids fail loudly — an agent promising a file
 * that doesn't exist is an error, not a silent omission.
 */
async function resolveOutboundAttachments(
  tenantId: string,
  fileIds: string[],
): Promise<{ wire: OutboundAttachment[]; refs: MailAttachmentRef[] }> {
  if (fileIds.length === 0) return { wire: [], refs: [] }
  const records = await getFileRecords(tenantId, fileIds)
  if (records.length !== fileIds.length) {
    const found = new Set(records.map((r) => r.id))
    const missing = fileIds.filter((id) => !found.has(id))
    throw new Error(`Attachment file(s) not found: ${missing.join(', ')}`)
  }
  const wire: OutboundAttachment[] = []
  const refs: MailAttachmentRef[] = []
  for (const record of records) {
    wire.push({
      filename: record.filename,
      content: await getFileBytes(record),
      contentType: record.contentType,
    })
    refs.push({
      fileId: record.id,
      filename: record.filename,
      contentType: record.contentType,
      size: record.sizeBytes,
    })
  }
  return { wire, refs }
}

type Account = typeof mailboxAccounts.$inferSelect

/**
 * Rebuild the live connection from an account row + its sealed credential.
 * A Google Workspace or Microsoft 365 mailbox mints a short-lived access token
 * for this one operation and authenticates with XOAUTH2; a self-hosted IMAP
 * mailbox unseals its password. A credential failure is recorded on the account
 * exactly like a failed sync, so the operator sees why the mailbox went quiet.
 * Call inside an existing tenant scope.
 */
async function toConnection(tenantId: string, account: Account): Promise<MailboxConnection> {
  if (!account.imap) throw new Error('Mailbox has no IMAP endpoint configuration.')
  const endpoints = {
    address: account.address,
    imap: { host: account.imap.imapHost, port: account.imap.imapPort, secure: account.imap.imapSecure },
    smtp: { host: account.imap.smtpHost, port: account.imap.smtpPort, secure: account.imap.smtpSecure },
  }
  if (mailOauthProviderOf(account)) {
    try {
      const { accessToken, username } = await freshAccessToken(tenantId, account)
      return { ...endpoints, username, password: '', accessToken }
    } catch (error) {
      await recordMailboxError(tenantId, account.id, error instanceof Error ? error.message : String(error))
      throw error
    }
  }
  const password = unsealSecret(JSON.parse(account.secretRef) as SealedSecret)
  if (password === null) throw new Error('Mailbox credential cannot be unsealed (APPKIT_SECRET changed?).')
  return { ...endpoints, username: account.imap.username, password }
}

export type ConnectMailboxInput = {
  tenantId: string
  personId: string
  address: string
  username: string
  password: string
  imapHost: string
  imapPort: number
  imapSecure: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
}

/** Verify both endpoints, seal the credential, and activate the agent. */
export async function connectMailbox(input: ConnectMailboxInput): Promise<string> {
  const connection: MailboxConnection = {
    address: input.address,
    imap: { host: input.imapHost, port: input.imapPort, secure: input.imapSecure },
    smtp: { host: input.smtpHost, port: input.smtpPort, secure: input.smtpSecure },
    username: input.username,
    password: input.password,
  }
  await verifyImap(connection)
  await verifySmtp(connection)

  const app = db()
  return app.withTenant(input.tenantId, async () => {
    const [account] = await app.db
      .insert(mailboxAccounts)
      .values({
        tenantId: input.tenantId,
        personId: input.personId,
        address: input.address,
        provider: 'imap',
        status: 'active',
        imap: {
          imapHost: input.imapHost,
          imapPort: input.imapPort,
          imapSecure: input.imapSecure,
          smtpHost: input.smtpHost,
          smtpPort: input.smtpPort,
          smtpSecure: input.smtpSecure,
          username: input.username,
        },
        secretRef: JSON.stringify(sealSecret(input.password)),
      })
      .returning({ id: mailboxAccounts.id })
    if (!account) throw new Error('Mailbox account could not be created.')
    // The agent's own address follows the mailbox, for the reason spelled out
    // in `linkMailbox`: colleagues reach an agent at `people.email`, and the
    // internal-versus-external dial reads the same column. Two names for one
    // fact silently misroute mail in both directions.
    const [clash] = await app.db
      .select({ name: people.name })
      .from(people)
      .where(and(sql`lower(${people.email}) = ${input.address.toLowerCase()}`, ne(people.id, input.personId)))
    if (clash) throw new Error(`${input.address} is already ${clash.name}'s address in the directory.`)
    await app.db
      .update(people)
      .set({ status: 'active', email: input.address })
      .where(eq(people.id, input.personId))
    return account.id
  })
}

/** Drizzle-backed MailboxStore for one account, tenant-scoped by the caller. */
function makeStore(tenantId: string, account: Account): MailboxStore {
  const app = db()
  return {
    getCursor: async () => (account.syncCursor as ImapCursor | null) ?? null,
    saveCursor: async (cursor) => {
      await app.db
        .update(mailboxAccounts)
        .set({ syncCursor: cursor, lastSyncAt: new Date(), lastError: null })
        .where(eq(mailboxAccounts.id, account.id))
    },
    hasMessage: async (messageId) => {
      const rows = await app.db
        .select({ id: mailMessages.id })
        .from(mailMessages)
        .innerJoin(mailThreads, eq(mailThreads.id, mailMessages.threadId))
        .where(and(eq(mailThreads.mailboxId, account.id), eq(mailMessages.externalMessageId, messageId)))
        .limit(1)
      return rows.length > 0
    },
    saveInbound: async (message) => {
      const participants = [message.from, ...message.to, ...message.cc]
      const [existing] = await app.db
        .select({ id: mailThreads.id })
        .from(mailThreads)
        .where(and(eq(mailThreads.mailboxId, account.id), eq(mailThreads.externalThreadKey, message.threadKey)))
      let threadId = existing?.id
      if (threadId) {
        await app.db
          .update(mailThreads)
          .set({ lastMessageAt: message.sentAt, open: true, participants })
          .where(eq(mailThreads.id, threadId))
      } else {
        const [thread] = await app.db
          .insert(mailThreads)
          .values({
            tenantId,
            mailboxId: account.id,
            subject: message.subject,
            externalThreadKey: message.threadKey,
            participants,
            lastMessageAt: message.sentAt,
          })
          .returning({ id: mailThreads.id })
        threadId = thread!.id
      }
      const attachments: MailAttachmentRef[] = []
      for (const attachment of message.attachments) {
        if (attachment.size > MAX_ATTACHMENT_BYTES) continue
        const record = await saveFile({
          tenantId,
          personId: account.personId,
          kind: 'attachment',
          filename: attachment.filename,
          contentType: attachment.contentType,
          bytes: attachment.content,
        })
        attachments.push({
          fileId: record.id,
          filename: record.filename,
          contentType: record.contentType,
          size: record.sizeBytes,
        })
      }
      await app.db
        .insert(mailMessages)
        .values({
          tenantId,
          threadId,
          direction: 'inbound',
          from: message.from,
          to: message.to,
          cc: message.cc,
          subject: message.subject,
          bodyText: message.text,
          bodyHtml: message.html,
          externalMessageId: message.messageId,
          attachments,
          sentAt: message.sentAt,
        })
        .onConflictDoNothing()
    },
  }
}

/**
 * One sync pass for a person's mailbox; records failures on the account row —
 * and clears them again the moment the connection comes back. Recovery has to
 * be automatic: the scheduler only sweeps `active` accounts, so a mailbox left
 * parked on a transient DNS blip or a restarted mail server would never be
 * swept again, and the agent would go silently deaf until someone noticed the
 * unanswered mail themselves.
 */
export async function syncPersonMailbox(tenantId: string, personId: string): Promise<{ saved: number }> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [account] = await app.db
      .select()
      .from(mailboxAccounts)
      .where(eq(mailboxAccounts.personId, personId))
    if (!account) throw new Error('No mailbox connected for this agent.')
    try {
      const result = await syncMailbox(await toConnection(tenantId, account), makeStore(tenantId, account))
      // A disconnected mailbox stays disconnected: only an errored account is
      // healed here, never one an operator deliberately took out of service.
      if (account.status === 'error') {
        await app.db
          .update(mailboxAccounts)
          .set({ status: 'active', lastError: null })
          .where(eq(mailboxAccounts.id, account.id))
      }
      return { saved: result.saved }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await app.db
        .update(mailboxAccounts)
        .set({ status: 'error', lastError: message })
        .where(eq(mailboxAccounts.id, account.id))
      throw error
    }
  })
}

/**
 * Hand a message to the mail server, giving a wobbly connection a second and
 * third chance before calling it a failure.
 *
 * A send that throws is terminal today: the agent is told "that did not work",
 * the run finishes, and the customer is never written to again. Most of what
 * goes wrong at this seam is transient — a dropped socket, a mail server
 * restarting, a momentary DNS failure — and is over in a couple of seconds.
 * Authentication and rejected-recipient errors are not transient, so they fail
 * immediately rather than being retried three times for nothing.
 */
async function sendWithRetry(
  connection: MailboxConnection,
  message: SendMailArgs,
): Promise<Awaited<ReturnType<typeof sendMail>>> {
  const attempts = 3
  let last: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await sendMail(connection, message)
    } catch (error) {
      last = error
      const text = (error instanceof Error ? error.message : String(error)).toLowerCase()
      const permanent =
        text.includes('auth') ||
        text.includes('credential') ||
        text.includes('no recipients') ||
        text.includes('mailbox unavailable') ||
        /\b5\d\d\b/.test(text)
      if (permanent || attempt === attempts) break
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)))
    }
  }
  throw last
}

/** Send a reply in a thread as the agent, and ledger the outbound message. */
export async function sendReplyInThread(args: {
  tenantId: string
  threadId: string
  text: string
  runId?: string
  attachFileIds?: string[]
}): Promise<void> {
  const attachments = await resolveOutboundAttachments(args.tenantId, args.attachFileIds ?? [])
  const signatureContext = await loadSignatureContext(args.tenantId)
  const app = db()
  await app.withTenant(args.tenantId, async () => {
    const [thread] = await app.db.select().from(mailThreads).where(eq(mailThreads.id, args.threadId))
    if (!thread) throw new Error('Thread not found.')
    const [account] = await app.db
      .select()
      .from(mailboxAccounts)
      .where(eq(mailboxAccounts.id, thread.mailboxId))
    if (!account) throw new Error('Thread has no mailbox.')
    const [owner] = await app.db.select().from(people).where(eq(people.id, account.personId))

    const messages = await app.db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.threadId, thread.id))
      .orderBy(desc(mailMessages.sentAt))
    const lastInbound = messages.find((m) => m.direction === 'inbound')
    const references = messages
      .map((m) => m.externalMessageId)
      .filter((id): id is string => !!id)
      .reverse()

    const counterparties = thread.participants.filter(
      (p) => p.address.toLowerCase() !== account.address.toLowerCase(),
    )
    const to = lastInbound ? [lastInbound.from] : counterparties
    if (to.length === 0) throw new Error('Nobody to reply to on this thread.')

    const signature = renderSignature(signatureContext, owner)
    const body = signature
      ? { text: outboundTextBody(args.text, signature.text), html: outboundHtmlBody(args.text, signature.html) }
      : { text: args.text }

    const sendArgs: SendMailArgs = {
      to,
      subject: thread.subject.startsWith('Re:') ? thread.subject : `Re: ${thread.subject}`,
      text: body.text,
      ...(body.html ? { html: body.html } : {}),
      ...(lastInbound?.externalMessageId ? { inReplyTo: lastInbound.externalMessageId } : {}),
      ...(references.length ? { references } : {}),
      ...(owner ? { fromName: owner.name } : {}),
      ...(attachments.wire.length ? { attachments: attachments.wire } : {}),
    }
    const sent = await sendWithRetry(await toConnection(args.tenantId, account), sendArgs)

    await app.db.insert(mailMessages).values({
      tenantId: args.tenantId,
      threadId: thread.id,
      direction: 'outbound',
      from: { ...(owner ? { name: owner.name } : {}), address: account.address },
      to,
      cc: [],
      subject: sendArgs.subject,
      bodyText: body.text,
      ...(body.html ? { bodyHtml: body.html } : {}),
      externalMessageId: sent.messageId,
      attachments: attachments.refs,
      runId: args.runId ?? null,
      sentAt: sent.sentAt,
    })
    await app.db
      .update(mailThreads)
      .set({ lastMessageAt: sent.sentAt })
      .where(eq(mailThreads.id, thread.id))
  })
}

/** Compose a NEW thread from an agent's mailbox (approval requests, outreach). */
export async function sendNewMail(args: {
  tenantId: string
  personId: string
  to: { name?: string; address: string }[]
  subject: string
  text: string
  runId?: string
  attachFileIds?: string[]
}): Promise<{ threadId: string }> {
  const attachments = await resolveOutboundAttachments(args.tenantId, args.attachFileIds ?? [])
  const signatureContext = await loadSignatureContext(args.tenantId)
  const app = db()
  return app.withTenant(args.tenantId, async () => {
    const [account] = await app.db
      .select()
      .from(mailboxAccounts)
      .where(eq(mailboxAccounts.personId, args.personId))
    if (!account) throw new Error('No mailbox connected for this agent.')
    const [owner] = await app.db.select().from(people).where(eq(people.id, args.personId))

    const signature = renderSignature(signatureContext, owner)
    const body = signature
      ? { text: outboundTextBody(args.text, signature.text), html: outboundHtmlBody(args.text, signature.html) }
      : { text: args.text }

    const sent = await sendWithRetry(await toConnection(args.tenantId, account), {
      to: args.to,
      subject: args.subject,
      text: body.text,
      ...(body.html ? { html: body.html } : {}),
      ...(owner ? { fromName: owner.name } : {}),
      ...(attachments.wire.length ? { attachments: attachments.wire } : {}),
    })
    const [thread] = await app.db
      .insert(mailThreads)
      .values({
        tenantId: args.tenantId,
        mailboxId: account.id,
        subject: args.subject,
        externalThreadKey: sent.messageId,
        participants: [{ ...(owner ? { name: owner.name } : {}), address: account.address }, ...args.to],
        lastMessageAt: sent.sentAt,
      })
      .returning({ id: mailThreads.id })
    await app.db.insert(mailMessages).values({
      tenantId: args.tenantId,
      threadId: thread!.id,
      direction: 'outbound',
      from: { ...(owner ? { name: owner.name } : {}), address: account.address },
      to: args.to,
      cc: [],
      subject: args.subject,
      bodyText: body.text,
      ...(body.html ? { bodyHtml: body.html } : {}),
      externalMessageId: sent.messageId,
      attachments: attachments.refs,
      runId: args.runId ?? null,
      sentAt: sent.sentAt,
    })
    return { threadId: thread!.id }
  })
}
