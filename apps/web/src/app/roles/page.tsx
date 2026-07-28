import { asc, eq } from 'drizzle-orm'
import { PageContainer, PageHeader } from '@appkit/ui'
import { people } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId } from '../../lib/tenant'
import { listRoles } from '../../lib/roles'
import { RolesView } from '../../components/roles-view'

export const dynamic = 'force-dynamic'

export default async function RolesPage() {
  const tenantId = await resolveTenantId()
  const app = db()
  const [roles, roster] = await Promise.all([
    listRoles(tenantId),
    app.withTenantContext(tenantId, () =>
      app.db
        .select({ id: people.id, name: people.name, title: people.title })
        .from(people)
        .where(eq(people.status, 'active'))
        .orderBy(asc(people.name)),
    ),
  ])

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Roles"
        description="The jobs agents can hold. Browse the built-ins, build your own, and onboard an agent from any of them."
      />
      <RolesView roles={roles} roster={roster} />
    </PageContainer>
  )
}
