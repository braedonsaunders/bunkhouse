'use server'

import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { mailboxAccounts, mailMessages, mailThreads } from '../../db/schema'
import { db } from '../../db/client'
import { sendNewMail, sendReplyInThread } from '../../lib/mailbox'
import { resolveTenantId as resolveTenant } from '../../lib/tenant'
const resolveTenantId = () => resolveTenant('mail.manage')

/**
 * Data + IO for the agent inbox (the Mail section on the employee record). The
 * component is controlled; these actions are its only server round-trips.
 */

export type MailFolderKey = 'inbox' | 'sent' | 'all'

export type MailThreadRow = {
  id: string
  counterparty: string
  subject: string
  at: string
  open: boolean
}

export type MailConversation = {
  subject: string
  messages: {
    id: string
    direction: 'inbound' | 'outbound'
    fromLabel: string
    toLabel: string
    at: string
    bodyText: string
    attachments: { filename: string; size: number; href: string }[]
  }[]
}

function folderFilter(folder: MailFolderKey) {
  if (folder === 'inbox') {
    return sql`exists (select 1 from mail_messages m where m.thread_id = ${mailThreads.id} and m.direction = 'inbound')`
  }
  if (folder === 'sent') {
    return sql`exists (select 1 from mail_messages m where m.thread_id = ${mailThreads.id} and m.direction = 'outbound')`
  }
  return sql`true`
}

async function threadRows(tenantId: string, mailboxId: string, folder: MailFolderKey): Promise<MailThreadRow[]> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [account] = await app.db
      .select({ address: mailboxAccounts.address })
      .from(mailboxAccounts)
      .where(eq(mailboxAccounts.id, mailboxId))
    if (!account) return []
    const threads = await app.db
      .select()
      .from(mailThreads)
      .where(and(eq(mailThreads.mailboxId, mailboxId), folderFilter(folder)))
      .orderBy(desc(mailThreads.lastMessageAt))
      .limit(50)
    return threads.map((thread) => ({
      id: thread.id,
      counterparty:
        thread.participants
          .filter((p) => p.address.toLowerCase() !== account.address.toLowerCase())
          .map((p) => p.name || p.address)
          .join(', ') || account.address,
      subject: thread.subject,
      at: thread.lastMessageAt.toISOString(),
      open: thread.open,
    }))
  })
}

export async function loadMailFolderAction(input: {
  mailboxId: string
  folder: MailFolderKey
}): Promise<{ threads: MailThreadRow[]; counts: Record<MailFolderKey, number> }> {
  const tenantId = await resolveTenantId()
  const app = db()
  const counts = await app.withTenantContext(tenantId, async () => {
    const count = async (folder: MailFolderKey): Promise<number> => {
      const [row] = await app.db
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(mailThreads)
        .where(and(eq(mailThreads.mailboxId, input.mailboxId), folderFilter(folder)))
      return row?.n ?? 0
    }
    return { inbox: await count('inbox'), sent: await count('sent'), all: await count('all') }
  })
  return { threads: await threadRows(tenantId, input.mailboxId, input.folder), counts }
}

export async function loadMailConversationAction(input: { threadId: string }): Promise<MailConversation | null> {
  const tenantId = await resolveTenantId()
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [thread] = await app.db.select().from(mailThreads).where(eq(mailThreads.id, input.threadId))
    if (!thread) return null
    const messages = await app.db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.threadId, thread.id))
      .orderBy(asc(mailMessages.sentAt))
    return {
      subject: thread.subject,
      messages: messages.map((message) => ({
        id: message.id,
        direction: message.direction,
        fromLabel: message.from.name || message.from.address,
        toLabel: message.to.map((t) => t.name || t.address).join(', '),
        at: message.sentAt.toISOString(),
        bodyText: message.bodyText,
        attachments: message.attachments.map((attachment) => ({
          filename: attachment.filename,
          size: attachment.size,
          href: `/api/files/${attachment.fileId}`,
        })),
      })),
    }
  })
}

/** A human replies from the agent's mailbox (manual assist / takeover). */
export async function replyToThreadAction(input: { threadId: string; text: string }): Promise<void> {
  const text = input.text.trim()
  if (!input.threadId || !text) throw new Error('A reply needs a thread and a body.')
  const tenantId = await resolveTenantId()
  await sendReplyInThread({ tenantId, threadId: input.threadId, text })
}

/** A human composes a fresh message from the agent's mailbox. */
export async function composeMailAction(input: {
  mailboxId: string
  to: string
  subject: string
  text: string
}): Promise<void> {
  const to = input.to.trim()
  const subject = input.subject.trim()
  const text = input.text.trim()
  if (!input.mailboxId || !to || !subject || !text) throw new Error('To, subject, and body are required.')
  const tenantId = await resolveTenantId()
  const app = db()
  const [account] = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ personId: mailboxAccounts.personId })
      .from(mailboxAccounts)
      .where(eq(mailboxAccounts.id, input.mailboxId)),
  )
  if (!account) throw new Error('Mailbox not found.')
  await sendNewMail({ tenantId, personId: account.personId, to: [{ address: to }], subject, text })
}
