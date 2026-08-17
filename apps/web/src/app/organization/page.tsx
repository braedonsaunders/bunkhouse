import Link from 'next/link'
import { asc } from 'drizzle-orm'
import { Button, FilterChips, PageContainer, PageHeader } from '@appkit/ui'
import { people } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId } from '../../lib/tenant'
import { listAvatarCompositions, loadAvatarPartLibrary } from '../../lib/avatars'
import { AVATAR_PART_CATEGORIES } from '../../lib/avatar-parts'
import { resolveCallAction } from '../../lib/call-action'
import { rosterModelCell } from '../../lib/model-assignment'
import { OrganizationTabs } from '../../components/organization-tabs'
import { RosterAvatar } from '../../components/roster-avatar'
import { AGENT_COLUMNS, RosterList, type RosterRow } from '../../components/roster-list'
import { personDrawer } from './person-record'

export const dynamic = 'force-dynamic'

const BASE_PATH = '/organization'
const STATUS_LABELS = { onboarding: 'Onboarding', active: 'Active', offboarded: 'Offboarded' } as const
/** Nobody is deleted, so the roster fills up with people who have left. */
const DEFAULT_STATUS = 'active'

/** The agents: AI employees, hired from a role pack and managed like staff. */
export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ person?: string; mailboxError?: string; tab?: string; thread?: string; status?: string }>
}) {
  const params = await searchParams
  const { person: selectedId, mailboxError, tab, thread } = params
  const status = params.status ?? DEFAULT_STATUS
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

  const agents = roster.filter((person) => person.kind === 'agent')
  // Counted over every agent, not the filtered view, so the chips say how many
  // are behind each option rather than how many are already on screen.
  const statusOptions = (['active', 'onboarding', 'offboarded'] as const).map((value) => ({
    value,
    label: STATUS_LABELS[value],
    count: agents.filter((person) => person.status === value).length,
  }))

  const rows: RosterRow[] = agents
    .filter((person) => status === 'all' || person.status === status)
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
      model: rosterModelCell(person.modelConfig),
      extension: person.extension ?? '—',
      reportsTo: person.reportsToId ? (byId.get(person.reportsToId)?.name ?? '—') : '—',
      status: STATUS_LABELS[person.status],
      statusValue: person.status,
      call: resolveCallAction(person),
    }))

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Agents"
        description="Your AI employees — each with a mailbox, duties, an autonomy dial, and a salary."
        actions={
          <Button asChild>
            <Link href="/roles">Onboard an agent</Link>
          </Button>
        }
      />
      <OrganizationTabs active="agents" />
      <RosterList
        rows={rows}
        columns={AGENT_COLUMNS}
        basePath={BASE_PATH}
        selectedId={selectedId}
        searchPlaceholder="Search agents…"
        filters={
          <FilterChips
            basePath={BASE_PATH}
            currentParams={params}
            paramKey="status"
            label="Status"
            options={statusOptions}
            defaultValue={DEFAULT_STATUS}
            allLabel="Any status"
          />
        }
        empty={
          agents.length === 0
            ? {
                title: 'No agents yet',
                description:
                  'Hire your first agent from a role pack — the pack brings its duties and procedures with it.',
              }
            : {
                // The roster is not empty; this filter's slice of it is. Saying
                // "no agents yet" here would read as having lost them.
                title: 'No agents with that status',
                description: 'Every agent on the roster is under one of the other statuses.',
              }
        }
      />
      {await personDrawer({
        tenantId,
        roster,
        selectedId,
        basePath: BASE_PATH,
        mailboxError,
        tab,
        mailThreadId: thread,
        searchParams: params,
      })}
    </PageContainer>
  )
}
