import { asc, eq } from 'drizzle-orm'
import { ROLE_PACKS } from '@bunkhouse/roles'
import { PageContainer, PageHeader } from '@appkit/ui'
import { people } from '../../../db/schema'
import { db } from '../../../db/client'
import { resolveTenantId } from '../../../lib/tenant'
import { HireView } from '../../../components/hire-view'

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
        title="Hiring"
        description="Browse the roles; click one to review it and extend an offer."
        back={{ href: '/people', label: 'Directory' }}
      />
      <HireView
        roles={ROLE_PACKS.map((pack) => ({
          slug: pack.slug,
          title: pack.title,
          pitch: pack.pitch,
          description: pack.description,
          duties: pack.duties.map((d) => ({ title: d.title, cron: d.cron })),
          procedures: pack.procedures.map((p) => ({ title: p.title })),
          salaryUsd: pack.suggestedSalaryUsd,
          defaultBio: pack.personality.bio,
        }))}
        roster={roster}
      />
    </PageContainer>
  )
}
