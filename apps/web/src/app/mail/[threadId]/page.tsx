import { notFound, redirect } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { mailboxAccounts, mailThreads } from '../../../db/schema'
import { db } from '../../../db/client'
import { resolveTenantId } from '../../../lib/tenant'

export const dynamic = 'force-dynamic'

/**
 * Old deep links (approval mails, run summaries) land here; mail lives on the
 * agent's flyout, so this resolves the thread's owner and forwards there.
 */
export default async function ThreadRedirect({ params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params
  const tenantId = await resolveTenantId()
  const app = db()
  const [thread] = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ id: mailThreads.id, personId: mailboxAccounts.personId })
      .from(mailThreads)
      .innerJoin(mailboxAccounts, eq(mailboxAccounts.id, mailThreads.mailboxId))
      .where(eq(mailThreads.id, threadId)),
  )
  if (!thread) notFound()
  redirect(`/organization/agents?person=${thread.personId}&tab=mailbox&thread=${thread.id}`)
}
