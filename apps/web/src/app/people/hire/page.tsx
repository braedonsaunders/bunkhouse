import Link from 'next/link'
import { asc, eq } from 'drizzle-orm'
import { ROLE_PACKS, getRolePack } from '@bunkhouse/roles'
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  PageContainer,
  PageHeader,
  Select,
  Textarea,
  cn,
} from '@appkit/ui'
import { people } from '../../../db/schema'
import { db } from '../../../db/client'
import { resolveTenantId } from '../../../lib/tenant'
import { hireHand } from '../actions'

export const dynamic = 'force-dynamic'

export default async function HirePage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string }>
}) {
  const params = await searchParams
  const selected = getRolePack(params.role ?? '')

  const tenantId = await resolveTenantId()
  const app = db()
  const roster = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ id: people.id, name: people.name, title: people.title })
      .from(people)
      .where(eq(people.status, 'active'))
      .orderBy(asc(people.name)),
  )

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Hiring"
        description="Browse the roles, review one, and extend an offer."
        back={{ href: '/people', label: 'Directory' }}
      />

      <div className="space-y-2">
        {ROLE_PACKS.map((pack) => {
          const isSelected = selected?.slug === pack.slug
          return (
            <div
              key={pack.slug}
              className={cn(
                'flex flex-wrap items-center justify-between gap-3 rounded-md border p-4',
                isSelected ? 'border-primary bg-primary/5' : 'border-border',
              )}
            >
              <div className="flex min-w-0 items-center gap-3">
                <Avatar name={pack.title} size={40} />
                <div className="min-w-0">
                  <p className="font-medium">{pack.title}</p>
                  <p className="truncate text-sm text-fg-muted">{pack.pitch}</p>
                </div>
              </div>
              <div className="flex items-center gap-3 text-sm text-fg-muted">
                <span>{pack.duties.length} duties</span>
                <span>{pack.procedures.length} procedures</span>
                <Badge variant="secondary">${pack.suggestedSalaryUsd}/mo</Badge>
                <Button asChild variant={isSelected ? 'default' : 'outline'} size="sm">
                  <Link href={`/people/hire?role=${pack.slug}`}>{isSelected ? 'Reviewing' : 'Review'}</Link>
                </Button>
              </div>
            </div>
          )
        })}
      </div>

      {selected ? (
        <Card className="border-primary/50">
          <CardHeader>
            <CardTitle>Offer letter — {selected.title}</CardTitle>
            <CardDescription>{selected.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={hireHand} className="grid gap-4 md:grid-cols-2">
              <input type="hidden" name="rolePack" value={selected.slug} />
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" placeholder="Dana Reeves" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email address on your domain</Label>
                <Input id="email" name="email" type="email" placeholder="dana@yourcompany.com" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="salaryUsd">Monthly salary (USD token budget)</Label>
                <Input
                  id="salaryUsd"
                  name="salaryUsd"
                  type="number"
                  min="1"
                  step="1"
                  defaultValue={selected.suggestedSalaryUsd}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="reportsToId">Reports to</Label>
                <Select id="reportsToId" name="reportsToId" defaultValue="">
                  <option value="">— Nobody yet —</option>
                  {roster.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name} — {person.title}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="bio">Personality (optional — the role has a good default)</Label>
                <Textarea id="bio" name="bio" rows={3} defaultValue={selected.personality.bio} />
              </div>
              <div className="md:col-span-2 flex items-center gap-3">
                <Button type="submit">Extend the offer</Button>
                <span className="text-xs text-fg-muted">
                  They start onboarding immediately; connect their mailbox to activate them.
                </span>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-fg-muted">Select a role to review it and extend an offer.</p>
      )}
    </PageContainer>
  )
}
