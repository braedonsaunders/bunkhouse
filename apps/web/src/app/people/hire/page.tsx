import { asc, eq } from 'drizzle-orm'
import { ROLE_PACKS } from '@bunkhouse/roles'
import {
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
} from '@appkit/ui'
import { people } from '../../../db/schema'
import { db } from '../../../db/client'
import { resolveTenantId } from '../../../lib/tenant'
import { hireHand } from '../actions'

export const dynamic = 'force-dynamic'

export default async function HirePage() {
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
        title="Hire a hand"
        description="Pick a role, give them a name and a mailbox-to-be, and they start onboarding."
        back={{ href: '/people', label: 'Directory' }}
      />
      <div className="grid gap-4 md:grid-cols-3">
        {ROLE_PACKS.map((pack) => (
          <Card key={pack.slug}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2">
                {pack.title}
                <Badge variant="secondary">${pack.suggestedSalaryUsd}/mo</Badge>
              </CardTitle>
              <CardDescription>{pack.pitch}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-fg-muted">
              <p>{pack.description}</p>
              <p className="text-xs">
                {pack.duties.length} standing duties · {pack.procedures.length} procedures included
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Offer letter</CardTitle>
          <CardDescription>
            The salary is their monthly model-token budget, paid to your own API keys.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={hireHand} className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="rolePack">Role</Label>
              <Select id="rolePack" name="rolePack" required defaultValue={ROLE_PACKS[0]?.slug}>
                {ROLE_PACKS.map((pack) => (
                  <option key={pack.slug} value={pack.slug}>
                    {pack.title}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" placeholder="Dana Reeves" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email address</Label>
              <Input id="email" name="email" type="email" placeholder="dana@yourcompany.com" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="salaryUsd">Monthly salary (USD token budget)</Label>
              <Input id="salaryUsd" name="salaryUsd" type="number" min="1" step="1" placeholder="60" />
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
              <Textarea id="bio" name="bio" rows={3} placeholder="How this hand introduces themselves and carries their work." />
            </div>
            <div className="md:col-span-2">
              <Button type="submit">Extend the offer</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </PageContainer>
  )
}
