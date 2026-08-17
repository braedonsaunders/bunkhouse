import { asc, eq } from 'drizzle-orm'
import { PageContainer, PageHeader } from '@braedonsaunders/appkit-ui'
import { people } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId } from '../../lib/tenant'
import { listRoles, seedProcedureSlug } from '../../lib/roles'
import { listResourceCatalog } from '../../lib/role-resources'
import { RolesView } from '../../components/roles-view'

export const dynamic = 'force-dynamic'

export default async function RolesPage() {
  const tenantId = await resolveTenantId('roles.read')
  const app = db()
  const [roles, catalog, roster] = await Promise.all([
    listRoles(tenantId),
    listResourceCatalog(tenantId),
    app.withTenantContext(tenantId, () =>
      app.db
        .select({ id: people.id, name: people.name, title: people.title })
        .from(people)
        .where(eq(people.status, 'active'))
        .orderBy(asc(people.name)),
    ),
  ])

  // A role's starter procedures are an offer, not a listing: once one is in the
  // library it is a governed procedure like any other and belongs in the
  // picker, not in "this role ships these".
  const installed = new Set(catalog.procedures.map((entry) => entry.slug))
  const withPendingSeeds = roles.map((role) => ({
    ...role,
    seedProcedures: role.seedProcedures.filter((seed) => !installed.has(seedProcedureSlug(role.slug, seed.slug))),
  }))

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Roles"
        description="The jobs agents can hold. A role is where the company's procedures, skills, knowledge and systems are handed out — write them once under Company resources, then give them to the roles that need them."
      />
      <RolesView roles={withPendingSeeds} roster={roster} catalog={catalog} />
    </PageContainer>
  )
}
