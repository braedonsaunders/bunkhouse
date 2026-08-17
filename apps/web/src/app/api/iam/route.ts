import { createDrizzleIamService } from '@braedonsaunders/appkit-iam/drizzle'
import { createIamHttpHandler } from '@braedonsaunders/appkit-iam/http'
import { db } from '../../../db/client'
import { getTenantAccess, requireTenantPermission } from '../../../lib/tenant'
import { PERMISSION_CATALOGUE } from '../../../lib/permissions'

const handler = createIamHttpHandler({
  authorize: async () => {
    await requireTenantPermission('access.manage')
  },
  resolveService: async () => {
    const access = await getTenantAccess()
    const app = db()
    return createDrizzleIamService({
      db: app.superDb as never,
      tenantId: access.tenantId,
      actor: {
        userId: access.user.id,
        name: access.user.name,
        isSuperAdmin: access.user.isSuperAdmin,
      },
      currentMembershipId: access.membershipId ?? undefined,
      permissionCatalogue: PERMISSION_CATALOGUE,
      roleCapabilities: (role) => ({
        updateKey: !role.isBuiltIn,
        updateDetails: role.key !== 'administrator',
        updatePermissions: role.key !== 'administrator',
        duplicate: true,
        delete: !role.isBuiltIn,
        reason:
          role.key === 'administrator'
            ? 'The Administrator role is locked to prevent workspace lockout.'
            : role.isBuiltIn
              ? 'Built-in role keys and deletion are protected.'
              : undefined,
      }),
    })
  },
})

export const POST = handler

