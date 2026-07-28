'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { AccountMenu, AppShell, ThemeProvider, UiLinkProvider, type SidebarNavGroup } from '@appkit/ui'
import { PageTransition } from '@appkit/ui/page-transition'
import { authClient } from '@/lib/auth-client'

const navigation: SidebarNavGroup[] = [
  { id: 'home', label: 'Home', items: [{ href: '/', label: 'Home', iconKey: 'home', exact: true, mobile: true }] },
  {
    id: 'organization',
    label: 'Organization',
    items: [
      { href: '/organization/people', label: 'People', iconKey: 'users' },
      { href: '/organization/agents', label: 'Agents', iconKey: 'hard-hat', mobile: true },
      { href: '/organization/chart', label: 'Org chart', iconKey: 'workflow' },
    ],
  },
  { id: 'roles', label: 'Roles', items: [{ href: '/roles', label: 'Roles', iconKey: 'clipboard' }] },
  { id: 'approvals', label: 'Approvals', items: [{ href: '/approvals', label: 'Approvals', iconKey: 'list-checks', mobile: true }] },
  { id: 'observatory', label: 'Observatory', items: [{ href: '/observatory', label: 'Observatory', iconKey: 'activity' }] },
  { id: 'knowledge', label: 'Knowledge', items: [{ href: '/knowledge', label: 'Knowledge', iconKey: 'library' }] },
  { id: 'settings', label: 'Settings', items: [{ href: '/admin/settings', label: 'Settings', iconKey: 'settings', mobile: true }] },
]

export type FrameUser = { name: string; email: string; isSuperAdmin?: boolean }

export type FrameTenant = {
  id: string
  name: string
  /** The user's switchable workspaces (active memberships). One entry → no switcher. */
  options: { value: string; label: string }[]
}

export function AppFrame({
  children,
  user,
  tenant,
  switchTenant,
}: {
  children: ReactNode
  user: FrameUser | null
  tenant?: FrameTenant | null
  /** Server action: validates membership, sets the httpOnly tenant cookie. */
  switchTenant?: (tenantId: string) => Promise<{ ok: boolean; message?: string }>
}) {
  const pathname = usePathname()
  // The sign-in screen renders bare (no shell chrome) but keeps the theme.
  if (pathname === '/login') {
    return <ThemeProvider>{children}</ThemeProvider>
  }
  // Multi-membership users get the workspace switcher; single-membership users
  // just see their workspace name in the context label.
  const organization =
    tenant && switchTenant && tenant.options.length > 1
      ? {
          label: 'Workspace',
          summary: tenant.name,
          value: tenant.id,
          options: tenant.options,
          onChange: async (value: string) => {
            if (value === tenant.id) return
            const result = await switchTenant(value)
            // A full navigation, not a soft refresh: every data path re-resolves
            // the tenant, so the whole tree must re-render from the server.
            if (result.ok) window.location.assign('/')
          },
        }
      : undefined
  return (
    <UiLinkProvider link={Link}>
      <ThemeProvider>
        <AppShell
          groups={navigation}
          pathname={pathname}
          brand={<strong>Bunkhouse</strong>}
          header={
            <AccountMenu
              name={user?.name || user?.email || 'Signed in'}
              email={user?.email ?? ''}
              contextLabel={tenant ? `${tenant.name} · workspace` : undefined}
              organization={organization}
              // Instance operation lives outside tenant settings; only super
              // admins see the doorway.
              {...(user?.isSuperAdmin
                ? { elevatedAccess: { label: 'Platform administration', href: '/superadmin' } }
                : {})}
              showTheme
              onSignOut={async () => {
                await authClient.signOut()
                window.location.assign('/login')
              }}
            />
          }
        >
          <PageTransition navigationKey={pathname}>{children}</PageTransition>
        </AppShell>
      </ThemeProvider>
    </UiLinkProvider>
  )
}
