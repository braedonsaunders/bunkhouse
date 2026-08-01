'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { AccountMenu, AppShell, ThemeProvider, UiLinkProvider, type SidebarNavGroup } from '@appkit/ui'
import { PageTransition } from '@appkit/ui/page-transition'
import { authClient } from '@/lib/auth-client'
import { Logo } from '@/components/brand-logo'

const navigation: SidebarNavGroup[] = [
  { id: 'home', label: 'Home', items: [{ href: '/', label: 'Home', iconKey: 'home', exact: true, mobile: true }] },
  {
    id: 'agents',
    label: 'Agents',
    // People and the org chart live behind the Agents page's own switcher —
    // the sidebar names the destination, the page offers the views.
    items: [{ href: '/organization', label: 'Agents', iconKey: 'hard-hat', mobile: true }],
  },
  { id: 'roles', label: 'Roles', items: [{ href: '/roles', label: 'Roles', iconKey: 'clipboard' }] },
  { id: 'approvals', label: 'Approvals', items: [{ href: '/approvals', label: 'Approvals', iconKey: 'list-checks', mobile: true }] },
  { id: 'observatory', label: 'Observatory', items: [{ href: '/observatory', label: 'Observatory', iconKey: 'activity' }] },
  { id: 'resources', label: 'Resources', items: [{ href: '/resources', label: 'Resources', iconKey: 'library' }] },
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
  allowedSections,
}: {
  children: ReactNode
  user: FrameUser | null
  tenant?: FrameTenant | null
  /** Server action: validates membership, sets the httpOnly tenant cookie. */
  switchTenant?: (tenantId: string) => Promise<{ ok: boolean; message?: string }>
  /** Navigation is derived from the same server-resolved grants as page authorization. */
  allowedSections: string[]
}) {
  const pathname = usePathname()
  // The sign-in screen and the guest meeting rooms render bare (no shell
  // chrome — a guest has no workspace to navigate) but keep the theme.
  if (pathname === '/login' || pathname.startsWith('/meet/')) {
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
          groups={navigation.filter((group) => allowedSections.includes(group.id ?? ''))}
          pathname={pathname}
          brand={<Logo animated size={17} />}
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
