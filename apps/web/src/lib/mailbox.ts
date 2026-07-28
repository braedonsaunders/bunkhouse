import 'server-only'
import { and, desc, eq } from 'drizzle-orm'
import { sealSecret, unsealSecret, type SealedSecret } from '@appkit/crypto'
import {
  sendMail,
  syncMailbox,
  verifyImap,
  verifySmtp,
  type ImapCursor,
  type MailboxConnection,
  type MailboxStore,
  type SendMailArgs,
} from '@appkit/mailbox'
import { mailboxAccounts, mailMessages, mailThreads, people } from '../db/schema'
import { db } from '../db/client'

type Account = typeof mailboxAccounts.$inferSelect

/** Rebuild the live connection from an account row + its sealed credential. */
function toConnection(account: Account): MailboxConnection {
  if (!account.imap) throw new Error('Mailbox has no IMAP endpoint configuration.')
  const password = unsealSecret(JSON.parse(account.secretRef) as SealedSecret)
  if (password === null) throw new Error('Mailbox credential cannot be unsealed (APPKIT_SECRET changed?).')
  return {
    address: account.address,
    imap: { host: account.imap.imapHost, port: account.imap.imapPort, secure: account.imap.imapSecure },
    smtp: { host: account.imap.smtpHost, port: account.imap.smtpPort, secure: account.imap.smtpSecure },
    username: account.imap.username,
    password,
  }
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
    await app.db.update(people).set({ status: 'active' }).where(eq(people.id, input.personId))
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
      // Attachment blobs are not persisted until the storage connector slice;
      // the message ledger records body + headers only.
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
          sentAt: message.sentAt,
        })
        .onConflictDoNothing()
    },
  }
}

/** One sync pass for a person's mailbox; records failures on the account row. */
export async function syncPersonMailbox(tenantId: string, personId: string): Promise<{ saved: number }> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [account] = await app.db
      .select()
      .from(mailboxAccounts)
      .where(eq(mailboxAccounts.personId, personId))
    if (!account) throw new Error('No mailbox connected for this agent.')
    try {
      const result = await syncMailbox(toConnection(account), makeStore(tenantId, account))
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

/** Send a reply in a thread as the agent, and ledger the outbound message. */
export async function sendReplyInThread(args: {
  tenantId: string
  threadId: string
  text: string
  runId?: string
}): Promise<void> {
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

    const sendArgs: SendMailArgs = {
      to,
      subject: thread.subject.startsWith('Re:') ? thread.subject : `Re: ${thread.subject}`,
      text: args.text,
      ...(lastInbound?.externalMessageId ? { inReplyTo: lastInbound.externalMessageId } : {}),
      ...(references.length ? { references } : {}),
      ...(owner ? { fromName: owner.name } : {}),
    }
    const sent = await sendMail(toConnection(account), sendArgs)

    await app.db.insert(mailMessages).values({
      tenantId: args.tenantId,
      threadId: thread.id,
      direction: 'outbound',
      from: { ...(owner ? { name: owner.name } : {}), address: account.address },
      to,
      cc: [],
      subject: sendArgs.subject,
      bodyText: args.text,
      externalMessageId: sent.messageId,
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
}): Promise<{ threadId: string }> {
  const app = db()
  return app.withTenant(args.tenantId, async () => {
    const [account] = await app.db
      .select()
      .from(mailboxAccounts)
      .where(eq(mailboxAccounts.personId, args.personId))
    if (!account) throw new Error('No mailbox connected for this agent.')
    const [owner] = await app.db.select().from(people).where(eq(people.id, args.personId))
    const sent = await sendMail(toConnection(account), {
      to: args.to,
      subject: args.subject,
      text: args.text,
      ...(owner ? { fromName: owner.name } : {}),
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
      bodyText: args.text,
      externalMessageId: sent.messageId,
      runId: args.runId ?? null,
      sentAt: sent.sentAt,
    })
    return { threadId: thread!.id }
  })
}
