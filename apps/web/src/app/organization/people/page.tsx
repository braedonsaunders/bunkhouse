import { asc } from 'drizzle-orm'
import { PageContainer, PageHeader } from '@appkit/ui'
import { OrganizationTabs } from '../../../components/organization-tabs'
import { people } from '../../../db/schema'
import { db } from '../../../db/client'
import { resolveTenantId } from '../../../lib/tenant'
import { listAvatarCompositions, loadAvatarPartLibrary } from '../../../lib/avatars'
import { AVATAR_PART_CATEGORIES } from '../../../lib/avatar-parts'
import { RosterAvatar } from '../../../components/roster-avatar'
import { PEOPLE_COLUMNS, RosterList, type RosterRow } from '../../../components/roster-list'
import { AddPersonDrawer } from '../../../components/add-person-drawer'
import { personDrawer } from '../person-record'

export const dynamic = 'force-dynamic'

const BASE_PATH = '/organization/people'
const STATUS_LABELS = { onboarding: 'Onboarding', active: 'Active', offboarded: 'Offboarded' } as const

/** The humans: real colleagues agents route work to and escalate to. */
export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ person?: string }>
}) {
  const params = await searchParams
  const selectedId = params.person
  const tenantId = await resolveTenantId('people.read')
  const app = db()
  const roster = await app.withTenantContext(tenantId, () =>
    app.db.select().from(people).orderBy(asc(people.name)),
  )
  // Every likeness is one composition over the shared parts library, cropped
  // to its head viewport for the row — never a separate portrait image.
  const [compositions, partLibrary] = await Promise.all([
    listAvatarCompositions(tenantId),
    loadAvatarPartLibrary(tenantId),
  ])
  const byId = new Map(roster.map((p) => [p.id, p]))

  const rows: RosterRow[] = roster
    .filter((person) => person.kind === 'human')
    .map((person) => ({
      id: person.id,
      name: person.name,
      avatar: (
        <RosterAvatar
          name={person.name}
          composition={compositions.get(person.id) ?? null}
          parts={partLibrary}
          categories={AVATAR_PART_CATEGORIES}
          size={26}
        />
      ),
      title: person.title,
      email: person.email,
      phone: person.phone ?? '—',
      reportsTo: person.reportsToId ? (byId.get(person.reportsToId)?.name ?? '—') : '—',
      status: STATUS_LABELS[person.status],
    }))

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="People"
        description="The humans on staff. Agents route work to them by email and escalate up their reporting line."
        actions={
          <AddPersonDrawer
            managers={roster
              .filter((person) => person.status !== 'offboarded')
              .map((person) => ({ id: person.id, name: person.name, title: person.title }))}
          />
        }
      />
      <OrganizationTabs active="people" />
      <RosterList
        rows={rows}
        columns={PEOPLE_COLUMNS}
        basePath={BASE_PATH}
        searchPlaceholder="Search people…"
        empty={{
          title: 'No people yet',
          description: 'Add the humans on staff so your agents know who owns what and where to escalate.',
        }}
      />
      {await personDrawer({ tenantId, roster, selectedId, basePath: BASE_PATH, searchParams: params })}
    </PageContainer>
  )
}
