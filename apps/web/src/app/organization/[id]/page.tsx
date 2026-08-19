import { notFound, redirect } from 'next/navigation'
import { asc } from 'drizzle-orm'
import { isUuid } from '@braedonsaunders/appkit-ui'
import { people } from '../../../db/schema'
import { db } from '../../../db/client'
import { requireTenantPermission } from '../../../lib/tenant'
import { personDrawer } from '../person-record'

export const dynamic = 'force-dynamic'

/**
 * Canonical deep link to one employee. An agent is a deep record — chat,
 * mail, work and profile — so it owns a full page. Human employees
 * remain compact records on the People roster and still open in its drawer.
 *
 * This segment also catches every unmatched path under /organization, so the id
 * is checked before it reaches the database: `people.id` is a uuid column, and
 * a stale bookmark like /organization/hands would otherwise surface a 500 from
 * Postgres rather than a 404.
 */
export default async function PersonPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{
    section?: string
    thread?: string
    mailboxError?: string
    profile?: string
    work?: string
    notePage?: string
    run?: string
    runTab?: string
    call?: string
  }>
}) {
  const { id } = await params
  const query = await searchParams
  if (!isUuid(id)) notFound()

  const access = await requireTenantPermission('people.read')
  const app = db()
  const roster = await app.withTenantContext(access.tenantId, () =>
    app.db.select().from(people).orderBy(asc(people.name)),
  )
  const person = roster.find((entry) => entry.id === id)
  if (!person) notFound()
  if (person.kind === 'human') redirect(`/organization/people?person=${id}`)

  const allowed = (permission: string) => access.user.isSuperAdmin || access.permissions.has(permission)
  return personDrawer({
    tenantId: access.tenantId,
    roster,
    selectedId: id,
    basePath: '/organization',
    display: 'page',
    pageAccess: {
      userId: access.user.id,
      canReadWork: allowed('work.read'),
      canReadMail: allowed('mail.read'),
      canCall: allowed('calls.manage'),
      canDecideApprovals: allowed('approvals.decide'),
    },
    section: query.section === 'inbox' ? 'mail' : query.section,
    chatThreadId: query.section === 'chat' ? query.thread : undefined,
    startCall: query.section === 'chat' && query.call === '1',
    mailThreadId: query.section === 'mail' || query.section === 'inbox' ? query.thread : undefined,
    mailboxError: query.mailboxError,
    profileSection: query.profile,
    workSection: query.work,
    runId: query.section === 'chat' ? query.run : undefined,
    runTab: query.runTab,
    searchParams: query,
  })
}
