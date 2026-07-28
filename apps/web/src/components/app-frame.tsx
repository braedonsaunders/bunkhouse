'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { AccountMenu, AppShell, ThemeProvider, UiLinkProvider, type SidebarNavGroup } from '@appkit/ui'
import { PageTransition } from '@appkit/ui/page-transition'

const navigation: SidebarNavGroup[] = [
  { id: 'home', label: 'Home', items: [{ href: '/', label: 'Home', iconKey: 'home', exact: true, mobile: true }] },
  { id: 'directory', label: 'Directory', items: [{ href: '/people', label: 'Directory', iconKey: 'users', mobile: true }] },
  { id: 'roles', label: 'Roles', items: [{ href: '/roles', label: 'Roles', iconKey: 'clipboard' }] },
  { id: 'approvals', label: 'Approvals', items: [{ href: '/approvals', label: 'Approvals', iconKey: 'list-checks', mobile: true }] },
  { id: 'observatory', label: 'Observatory', items: [{ href: '/observatory', label: 'Observatory', iconKey: 'activity' }] },
  { id: 'knowledge', label: 'Knowledge', items: [{ href: '/knowledge', label: 'Knowledge', iconKey: 'library' }] },
  { id: 'settings', label: 'Settings', items: [{ href: '/admin/settings', label: 'Settings', iconKey: 'settings', mobile: true }] },
]

export function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  return (
    <UiLinkProvider link={Link}>
      <ThemeProvider>
        <AppShell
          groups={navigation}
          pathname={pathname}
          brand={<strong>Bunkhouse</strong>}
          header={
            <AccountMenu
              name="Demo Owner"
              email="owner@bunkhouse.local"
              contextLabel="Bunkhouse Demo Co · workspace"
              roleLabel="Owner"
              status={{ label: 'Authentication not configured', variant: 'secondary' }}
              showTheme
            />
          }
        >
          <PageTransition navigationKey={pathname}>{children}</PageTransition>
        </AppShell>
      </ThemeProvider>
    </UiLinkProvider>
  )
}
