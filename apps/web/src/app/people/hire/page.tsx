import { asc, eq } from 'drizzle-orm'
import { ROLE_PACKS, getRolePack } from '@bunkhouse/roles'
import {
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
} from '@appkit/ui'
import { people } from '../../../db/schema'
import { db } from '../../../db/client'
import { resolveTenantId } from '../../../lib/tenant'
import { HireRoleList, type RoleRow } from '../../../components/hire-role-list'
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

  const rows: RoleRow[] = ROLE_PACKS.map((pack) => ({
    slug: pack.slug,
    title: pack.title,
    pitch: pack.pitch,
    duties: pack.duties.length,
    procedures: pack.procedures.length,
    salaryUsd: pack.suggestedSalaryUsd,
    statusLabel: selected?.slug === pack.slug ? 'Reviewing' : 'Available',
  }))

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Hiring"
        description="Browse the roles, review one, and extend an offer."
        back={{ href: '/people', label: 'Directory' }}
      />

      <HireRoleList rows={rows} />

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
