import { notFound, redirect } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { mailThreads } from '../../../db/schema'
import { db } from '../../../db/client'
import { resolveTenantId } from '../../../lib/tenant'

export const dynamic = 'force-dynamic'

/**
 * Old deep links (approval mails, run summaries) land here; the one mail
 * surface is /mail, so this resolves the thread's mailbox and forwards.
 */
export default async function ThreadRedirect({ params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params
  const tenantId = await resolveTenantId()
  const app = db()
  const [thread] = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ id: mailThreads.id, mailboxId: mailThreads.mailboxId })
      .from(mailThreads)
      .where(eq(mailThreads.id, threadId)),
  )
  if (!thread) notFound()
  redirect(`/mail?mailbox=${thread.mailboxId}&folder=all&thread=${thread.id}`)
}
