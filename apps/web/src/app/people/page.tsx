import Link from 'next/link'
import { asc } from 'drizzle-orm'
import { Button, PageContainer, PageHeader } from '@appkit/ui'
import { people } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId } from '../../lib/tenant'
import { PeopleList, type PersonRow } from '../../components/people-list'

export const dynamic = 'force-dynamic'

const STATUS_LABELS = { onboarding: 'Onboarding', active: 'Active', offboarded: 'Offboarded' } as const

export default async function PeoplePage() {
  const tenantId = await resolveTenantId()
  const app = db()
  const roster = await app.withTenantContext(tenantId, () =>
    app.db.select().from(people).orderBy(asc(people.name)),
  )
  const byId = new Map(roster.map((p) => [p.id, p]))
  const rows: PersonRow[] = roster.map((person) => ({
    id: person.id,
    name: person.name,
    title: person.title,
    kind: person.kind === 'hand' ? 'Hand' : 'Human',
    email: person.email,
    reportsTo: person.reportsToId ? (byId.get(person.reportsToId)?.name ?? '—') : '—',
    status: STATUS_LABELS[person.status],
  }))

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Directory"
        description="Everyone who works here — your people and your hands, one org."
        actions={
          <Button asChild>
            <Link href="/people/hire">Hire a hand</Link>
          </Button>
        }
      />
      <PeopleList rows={rows} />
    </PageContainer>
  )
}
