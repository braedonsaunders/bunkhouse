'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { mailboxAccounts, people } from '../../db/schema'
import { db } from '../../db/client'
import { sendNewMail, sendReplyInThread } from '../../lib/mailbox'
import { resolveTenantId } from '../../lib/tenant'

/** A human sends a reply from the agent's mailbox (manual assist / takeover). */
export async function replyAction(formData: FormData): Promise<void> {
  const threadId = String(formData.get('threadId') ?? '')
  const text = String(formData.get('text') ?? '').trim()
  if (!threadId || !text) throw new Error('A reply needs a thread and a body.')
  const tenantId = await resolveTenantId()
  await sendReplyInThread({ tenantId, threadId, text })
  revalidatePath('/mail')
}

/** A human composes a fresh message from the agent's mailbox. */
export async function composeAction(formData: FormData): Promise<void> {
  const accountId = String(formData.get('accountId') ?? '')
  const to = String(formData.get('to') ?? '').trim()
  const subject = String(formData.get('subject') ?? '').trim()
  const text = String(formData.get('text') ?? '').trim()
  if (!accountId || !to || !subject || !text) throw new Error('To, subject, and body are required.')

  const tenantId = await resolveTenantId()
  const app = db()
  const personId = await app.withTenantContext(tenantId, async () => {
    const [account] = await app.db
      .select({ personId: mailboxAccounts.personId })
      .from(mailboxAccounts)
      .where(eq(mailboxAccounts.id, accountId))
    if (!account) throw new Error('Mailbox not found.')
    const [owner] = await app.db
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.id, account.personId)))
    if (!owner) throw new Error('Mailbox has no owner.')
    return owner.id
  })
  await sendNewMail({
    tenantId,
    personId,
    to: [{ address: to }],
    subject,
    text,
  })
  revalidatePath('/mail')
}
