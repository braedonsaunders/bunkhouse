'use client'

import * as React from 'react'
import Link from 'next/link'
import { Building2, UserCog } from 'lucide-react'
import { SettingsShell, type LinkRender, type SettingsNavGroup } from '@appkit/ui'
import { PlatformUsersAdmin, PlatformSessionsAdmin, PlatformTenantsAdmin } from '@appkit/superadmin/react'
import type { PlatformSessionRecord, PlatformTenantRecord, PlatformUserRecord, TenantMemberRecord } from '@appkit/superadmin'
import {
  addPlatformTenantMemberAction,
  createPlatformTenantAction,
  createPlatformUserAction,
  removePlatformTenantMemberAction,
  revokePlatformSessionAction,
  revokePlatformUserSessionsAction,
  setPlatformTenantMemberStatusAction,
  setPlatformTenantStatusAction,
  setPlatformUserPasswordAction,
  updatePlatformUserAction,
} from '../app/superadmin/actions'

const nextLink: LinkRender = ({ href, children, className, title }) => (
  <Link href={href} className={className} title={title}>
    {children}
  </Link>
)

const NAV: SettingsNavGroup[] = [
  {
    label: 'Platform',
    items: [
      { key: 'users', label: 'Users', icon: <UserCog /> },
      { key: 'tenants', label: 'Tenants', icon: <Building2 /> },
    ],
  },
]

export type PlatformAdminData = {
  users: PlatformUserRecord[]
  sessions: PlatformSessionRecord[]
  currentUserId: string
  tenants: PlatformTenantRecord[]
  /** tenantId → members, preloaded server-side. */
  tenantMembers: Record<string, TenantMemberRecord[]>
  /** The tenant the operator is currently working in. */
  currentTenantId: string
}

/**
 * Platform administration — the instance operator's area, deliberately outside
 * tenant Settings: everything here is global (sign-in accounts, workspaces,
 * live sessions), while Settings is one workspace's configuration. Reached
 * from the account menu; every action re-authorizes super-admin server-side.
 */
export function SuperadminView({ platform }: { platform: PlatformAdminData }) {
  const [active, setActive] = React.useState('users')

  return (
    <SettingsShell
      title="Platform administration"
      description="The instance itself: who can sign in, the workspaces they belong to, and the sessions currently open."
      nav={NAV}
      activeKey={active}
      onSelect={setActive}
      contentWidth="wide"
      linkRender={nextLink}
    >
      {active === 'users' ? (
        <div className="space-y-10">
          <PlatformUsersAdmin
            users={platform.users}
            currentUserId={platform.currentUserId}
            tenants={platform.tenants
              .filter((tenant) => tenant.status === 'active')
              .map((tenant) => ({ id: tenant.id, name: tenant.name }))}
            defaultTenantId={platform.currentTenantId}
            actions={{
              createUser: createPlatformUserAction,
              updateUser: updatePlatformUserAction,
              setPassword: setPlatformUserPasswordAction,
              revokeUserSessions: revokePlatformUserSessionsAction,
            }}
          />
          <PlatformSessionsAdmin
            sessions={platform.sessions}
            actions={{ revokeSession: revokePlatformSessionAction }}
          />
        </div>
      ) : null}

      {active === 'tenants' ? (
        <PlatformTenantsAdmin
          tenants={platform.tenants}
          members={platform.tenantMembers}
          currentTenantId={platform.currentTenantId}
          actions={{
            createTenant: createPlatformTenantAction,
            setTenantStatus: setPlatformTenantStatusAction,
            addMember: addPlatformTenantMemberAction,
            setMemberStatus: setPlatformTenantMemberStatusAction,
            removeMember: removePlatformTenantMemberAction,
          }}
        />
      ) : null}
    </SettingsShell>
  )
}
