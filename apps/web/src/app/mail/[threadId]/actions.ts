'use server'

import { revalidatePath } from 'next/cache'
import { sendReplyInThread } from '../../../lib/mailbox'
import { resolveTenantId } from '../../../lib/tenant'

/** A human sends a reply from the hand's mailbox (manual assist / takeover). */
export async function replyAction(formData: FormData): Promise<void> {
  const threadId = String(formData.get('threadId') ?? '')
  const text = String(formData.get('text') ?? '').trim()
  if (!threadId || !text) throw new Error('A reply needs a thread and a body.')
  const tenantId = await resolveTenantId()
  await sendReplyInThread({ tenantId, threadId, text })
  revalidatePath(`/mail/${threadId}`)
}
