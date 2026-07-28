import Link from 'next/link'
import { asc } from 'drizzle-orm'
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  PageContainer,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@appkit/ui'
import { people } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId } from '../../lib/tenant'

export const dynamic = 'force-dynamic'

const STATUS_LABELS = { onboarding: 'Onboarding', active: 'Active', offboarded: 'Offboarded' } as const

export default async function PeoplePage() {
  const tenantId = await resolveTenantId()
  const app = db()
  const roster = await app.withTenantContext(tenantId, () =>
    app.db.select().from(people).orderBy(asc(people.name)),
  )
  const byId = new Map(roster.map((p) => [p.id, p]))

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
      {roster.length === 0 ? (
        <EmptyState
          title="Nobody here yet"
          description="Add your human team, then hire your first hand from a role pack."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Reports to</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {roster.map((person) => (
              <TableRow key={person.id}>
                <TableCell>
                  <Link href={`/people/${person.id}`} className="flex items-center gap-2 font-medium text-fg hover:text-primary">
                    <Avatar name={person.name} size={28} />
                    {person.name}
                  </Link>
                </TableCell>
                <TableCell>{person.title}</TableCell>
                <TableCell>
                  <Badge variant={person.kind === 'hand' ? 'default' : 'secondary'}>
                    {person.kind === 'hand' ? 'Hand' : 'Human'}
                  </Badge>
                </TableCell>
                <TableCell className="text-fg-muted">{person.email}</TableCell>
                <TableCell className="text-fg-muted">
                  {person.reportsToId ? byId.get(person.reportsToId)?.name ?? '—' : '—'}
                </TableCell>
                <TableCell>
                  <Badge variant={person.status === 'active' ? 'default' : 'outline'}>
                    {STATUS_LABELS[person.status]}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PageContainer>
  )
}
