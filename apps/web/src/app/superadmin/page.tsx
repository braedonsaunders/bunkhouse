import { redirect } from 'next/navigation'
import { hashPassword } from 'better-auth/crypto'
import { PageContainer } from '@appkit/ui'
import { createDrizzleSuperadminService } from '@appkit/superadmin/drizzle'
import { db } from '../../db/client'
import { getSuperAdminContext } from '../../lib/auth'
import { resolveTenantId } from '../../lib/tenant'
import { SuperadminView } from '../../components/superadmin-view'

export const dynamic = 'force-dynamic'

/**
 * Platform administration — global by nature (sign-in accounts, workspaces,
 * live sessions), so it lives outside tenant Settings. The account menu links
 * here for super admins; anyone else is turned away before any data loads,
 * and every action re-authorizes independently.
 */
export default async function SuperadminPage() {
  const operator = await getSuperAdminContext()
  if (!operator) redirect('/')
  const tenantId = await resolveTenantId()
  const app = db()

  const superadmin = createDrizzleSuperadminService({
    db: app.superDb,
    hashPassword,
    actor: { userId: operator.userId, sessionId: operator.sessionId, tenantId },
  })
  const [userList, sessionList, tenantList] = await Promise.all([
    superadmin.listUsers({ perPage: 100, sort: 'name' }),
    superadmin.listSessions({ perPage: 100, sort: 'created', direction: 'desc' }),
    superadmin.listTenants(),
  ])
  const memberLists = await Promise.all(
    tenantList.map(async (tenant) => [tenant.id, await superadmin.listTenantMembers(tenant.id)] as const),
  )

  return (
    <PageContainer>
      <SuperadminView
        platform={{
          users: userList.rows,
          sessions: sessionList.rows,
          currentUserId: operator.userId,
          tenants: tenantList,
          tenantMembers: Object.fromEntries(memberLists),
          currentTenantId: tenantId,
        }}
      />
    </PageContainer>
  )
}
