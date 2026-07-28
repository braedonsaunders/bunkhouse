'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { AccountMenu, AppShell, ThemeProvider, UiLinkProvider, type SidebarNavGroup } from '@appkit/ui'
import { PageTransition } from '@appkit/ui/page-transition'

const navigation: SidebarNavGroup[] = [
  {
    id: 'app',
    label: 'Application',
    items: [
      { href: '/', label: 'Home', iconKey: 'home', exact: true, mobile: true },
      { href: '/people', label: 'Directory', iconKey: 'users', mobile: true },
      { href: '/approvals', label: 'Approvals', iconKey: 'list-checks', mobile: true },
      { href: '/admin', label: 'Admin', iconKey: 'settings' },
    ],
  },
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
