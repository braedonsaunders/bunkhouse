import { redirect } from 'next/navigation'
import { asc, eq } from 'drizzle-orm'
import { mailboxAccounts, people } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId } from '../../lib/tenant'

export const dynamic = 'force-dynamic'

/**
 * Mail lives on the agent's own record — the Mailbox tab of the flyout. Old
 * /mail links land on the first connected mailbox's inbox there.
 */
export default async function MailRedirect({
  searchParams,
}: {
  searchParams: Promise<{ mailbox?: string; thread?: string }>
}) {
  const params = await searchParams
  const tenantId = await resolveTenantId('mail.read')
  const app = db()
  const accounts = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ id: mailboxAccounts.id, personId: mailboxAccounts.personId })
      .from(mailboxAccounts)
      .innerJoin(people, eq(people.id, mailboxAccounts.personId))
      .orderBy(asc(people.name)),
  )
  const account = accounts.find((a) => a.id === params.mailbox) ?? accounts[0]
  if (!account) redirect('/organization')
  redirect(
    `/organization?person=${account.personId}&tab=mailbox${params.thread ? `&thread=${params.thread}` : ''}`,
  )
}
