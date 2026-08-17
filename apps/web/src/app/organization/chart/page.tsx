import { asc } from 'drizzle-orm'
import { redirect } from 'next/navigation'
import type { OrgChartNode } from '@braedonsaunders/appkit-ui'
import { EmptyState, FilterChips, PageContainer, PageHeader } from '@braedonsaunders/appkit-ui'
import { OrganizationTabs } from '../../../components/organization-tabs'
import { people } from '../../../db/schema'
import { db } from '../../../db/client'
import { resolveTenantId } from '../../../lib/tenant'
import { listAvatarCompositions, loadAvatarPartLibrary } from '../../../lib/avatars'
import { AVATAR_PART_CATEGORIES } from '../../../lib/avatar-parts'
import { RosterAvatar } from '../../../components/roster-avatar'
import { OrgChartView } from '../../../components/org-chart-view'
import { personDrawer } from '../person-record'

export const dynamic = 'force-dynamic'

const BASE_PATH = '/organization/chart'

/**
 * The formal reporting hierarchy — humans and agents on one chart, because
 * that is the whole point: an agent escalates to its manager whether that
 * manager is a person or another agent. Offboarded records are hidden by
 * default so the chart shows who is actually here.
 */
export default async function OrgChartPage({
  searchParams,
}: {
  searchParams: Promise<{ person?: string; show?: string }>
}) {
  const params = await searchParams
  const { person: selectedId, show } = params
  const includeOffboarded = show === 'all'
  const tenantId = await resolveTenantId('people.read')
  const app = db()
  const roster = await app.withTenantContext(tenantId, () =>
    app.db.select().from(people).orderBy(asc(people.name)),
  )
  if (selectedId && roster.some((person) => person.id === selectedId && person.kind === 'agent')) {
    redirect(`/organization/${selectedId}`)
  }
  const [compositions, partLibrary] = await Promise.all([
    listAvatarCompositions(tenantId),
    loadAvatarPartLibrary(tenantId),
  ])

  const charted = roster.filter((person) => includeOffboarded || person.status !== 'offboarded')
  const chartedIds = new Set(charted.map((person) => person.id))
  const nodes: OrgChartNode[] = charted.map((person) => ({
    id: person.id,
    // A manager hidden by the filter would otherwise strand their reports;
    // dropping the pointer surfaces them at the top level instead.
    parentId: person.reportsToId && chartedIds.has(person.reportsToId) ? person.reportsToId : null,
    name: person.name,
    subtitle: person.title,
    meta: person.email,
    // Keyed because this element travels inside the `nodes` array: React
    // validates elements reached through an array as list children, even
    // though the chart renders each one as a single child of its card.
    avatar: (
      <RosterAvatar
        key={person.id}
        name={person.name}
        composition={compositions.get(person.id) ?? null}
        parts={partLibrary}
        categories={AVATAR_PART_CATEGORIES}
        size={44}
      />
    ),
    badge:
      person.kind === 'agent'
        ? { label: 'Agent', variant: 'default' as const }
        : { label: 'Person', variant: 'secondary' as const },
    muted: person.status !== 'active',
  }))

  const unmanaged = nodes.filter((node) => !node.parentId).length

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Org chart"
        description="Who reports to whom. Drag a card onto someone to change their manager, or open a record to edit it."
      />
      <OrganizationTabs active="chart" />
      {nodes.length === 0 ? (
        <EmptyState
          title="Nobody to chart yet"
          description="Add the people on staff and hire an agent — the reporting lines you set on each record draw this chart."
        />
      ) : (
        <OrgChartView
          people={nodes}
          agentIds={charted.filter((person) => person.kind === 'agent').map((person) => person.id)}
          selectedId={selectedId}
          toolbar={
            <div className="flex items-center gap-3">
              {unmanaged > 1 ? (
                <span className="hidden text-xs text-fg-muted sm:inline">
                  {unmanaged} sit at the top level — drag them onto a manager to place them.
                </span>
              ) : null}
              <FilterChips
                basePath={BASE_PATH}
                currentParams={{ ...(selectedId ? { person: selectedId } : {}) }}
                paramKey="show"
                label="Show"
                options={[
                  { value: 'current', label: 'Currently here' },
                  { value: 'all', label: 'Include offboarded' },
                ]}
                defaultValue="current"
                hideAll
              />
            </div>
          }
        />
      )}
      {await personDrawer({ tenantId, roster, selectedId, basePath: BASE_PATH, searchParams: params })}
    </PageContainer>
  )
}
