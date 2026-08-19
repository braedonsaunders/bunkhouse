'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { AccountMenu, AppShell, ThemeProvider, UiLinkProvider, type SidebarNavGroup } from '@braedonsaunders/appkit-ui'
import { PageTransition } from '@braedonsaunders/appkit-ui/page-transition'
import { authClient } from '@/lib/auth-client'
import { Logo } from '@/components/brand-logo'
import { productMessage, type AppLocale } from '@/lib/product-locales'

type NavigationGroup = Omit<SidebarNavGroup, 'items'> & {
  items: Array<SidebarNavGroup['items'][number] & { section: string }>
}

/** Five operator destinations; related records live inside their workspace menu. */
const navigationFor = (locale: AppLocale): NavigationGroup[] => [
  {
    id: 'home',
    label: productMessage(locale, 'nav.home'),
    items: [{ section: 'home', href: '/', label: productMessage(locale, 'nav.home'), iconKey: 'home', exact: true, mobile: true }],
  },
  {
    id: 'team',
    label: productMessage(locale, 'nav.team'),
    iconKey: 'hard-hat',
    items: [
      { section: 'agents', href: '/organization', label: productMessage(locale, 'nav.agents'), iconKey: 'hard-hat', mobile: true },
      { section: 'agents', href: '/organization/people', label: productMessage(locale, 'nav.people'), iconKey: 'users' },
      { section: 'agents', href: '/organization/chart', label: productMessage(locale, 'nav.orgChart'), iconKey: 'workflow' },
      { section: 'roles', href: '/roles', label: productMessage(locale, 'nav.roles'), iconKey: 'clipboard' },
    ],
  },
  {
    id: 'work',
    label: productMessage(locale, 'nav.work'),
    iconKey: 'activity',
    items: [
      { section: 'observatory', href: '/observatory', label: productMessage(locale, 'nav.activity'), iconKey: 'activity', mobile: true },
      { section: 'approvals', href: '/approvals', label: productMessage(locale, 'nav.approvals'), iconKey: 'list-checks', mobile: true },
    ],
  },
  {
    id: 'library',
    label: productMessage(locale, 'nav.library'),
    items: [{ section: 'resources', href: '/resources', label: productMessage(locale, 'nav.library'), iconKey: 'library' }],
  },
  {
    id: 'settings',
    label: productMessage(locale, 'nav.settings'),
    items: [{ section: 'settings', href: '/admin/settings', label: productMessage(locale, 'nav.settings'), iconKey: 'settings', mobile: true }],
  },
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
  locale,
}: {
  children: ReactNode
  user: FrameUser | null
  tenant?: FrameTenant | null
  /** Server action: validates membership, sets the httpOnly tenant cookie. */
  switchTenant?: (tenantId: string) => Promise<{ ok: boolean; message?: string }>
  /** Navigation is derived from the same server-resolved grants as page authorization. */
  allowedSections: string[]
  /** Effective tenant/member locale, resolved on the server. */
  locale: AppLocale
}) {
  const pathname = usePathname()
  const visibleNavigation: SidebarNavGroup[] = navigationFor(locale)
    .map((group) => ({
      ...group,
      items: group.items
        .filter((item) => allowedSections.includes(item.section))
        .map(({ section, ...item }) => {
          void section
          return item
        }),
    }))
    .filter((group) => group.items.length > 0)
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
          label: productMessage(locale, 'account.workspacePicker'),
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
          groups={visibleNavigation}
          pathname={pathname}
          brand={<Logo animated size={17} />}
          header={
            <AccountMenu
              name={user?.name || user?.email || productMessage(locale, 'account.signedIn')}
              email={user?.email ?? ''}
              contextLabel={tenant ? `${tenant.name} · ${productMessage(locale, 'account.workspace')}` : undefined}
              organization={organization}
              // Instance operation lives outside tenant settings; only super
              // admins see the doorway.
              {...(user?.isSuperAdmin
                ? { elevatedAccess: { label: productMessage(locale, 'account.platformAdministration'), href: '/superadmin' } }
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
