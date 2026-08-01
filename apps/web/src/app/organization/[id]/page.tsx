import { notFound, redirect } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { isUuid } from '@appkit/ui'
import { people } from '../../../db/schema'
import { db } from '../../../db/client'
import { resolveTenantId } from '../../../lib/tenant'

export const dynamic = 'force-dynamic'

/**
 * Canonical deep link to one record. People and agents have their own rosters,
 * so this resolves which one the record belongs to and lands on that page with
 * the drawer open — callers holding only an id need not care which.
 *
 * This segment also catches every unmatched path under /organization, so the id
 * is checked before it reaches the database: `people.id` is a uuid column, and
 * a stale bookmark like /organization/hands would otherwise surface a 500 from
 * Postgres rather than a 404.
 */
export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()

  const tenantId = await resolveTenantId('people.read')
  const app = db()
  const [person] = await app.withTenantContext(tenantId, () =>
    app.db.select({ kind: people.kind }).from(people).where(eq(people.id, id)),
  )
  if (!person) notFound()
  // The agent roster is the section root; only the people roster is nested.
  redirect(`/organization${person.kind === 'agent' ? '' : '/people'}?person=${id}`)
}
