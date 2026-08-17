import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { ConfirmRoot, getThemeScript, PromptRoot, Toaster } from '@appkit/ui'
import { AppFrame, type FrameTenant } from '@/components/app-frame'
import { SplashScreen } from '@/components/brand-splash'
import { getSessionUser } from '@/lib/auth'
import { getTenantAccess, getTenantSelectionForChrome } from '@/lib/tenant'
import { switchTenantAction } from '@/app/tenant-actions'
import './globals.css'

export const metadata: Metadata = {
  title: 'Bunkhouse',
  description: 'AI employees for your company',
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Chrome-level identity: the real signed-in account for the account menu.
  // Null on /login (which renders without the shell). Enforcement is NOT here —
  // it's requireUser() inside resolveTenantId on every data path.
  const user = await getSessionUser()
  // Membership-resolved workspace context: the CURRENT tenant's name, plus the
  // user's other active memberships when a switcher should render.
  const selection = user ? await getTenantSelectionForChrome() : null
  const tenant: FrameTenant | null = selection?.current
    ? {
        id: selection.current.id,
        name: selection.current.name,
        options: selection.options.map((option) => ({ value: option.id, label: option.name })),
      }
    : null
  const access = user && tenant ? await getTenantAccess() : null
  const allowedSections = user?.isSuperAdmin
    ? ['home', 'agents', 'chat', 'roles', 'approvals', 'observatory', 'resources', 'settings']
    : [
        access?.permissions.has('work.read') ? 'home' : null,
        access?.permissions.has('people.read') ? 'agents' : null,
        access?.permissions.has('work.read') ? 'chat' : null,
        access?.permissions.has('roles.read') ? 'roles' : null,
        access?.permissions.has('approvals.read') ? 'approvals' : null,
        access?.permissions.has('observatory.read') ? 'observatory' : null,
        access?.permissions.has('resources.read') ? 'resources' : null,
        access?.permissions.has('settings.read') ? 'settings' : null,
      ].filter((value): value is string => value !== null)
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script id="appkit-theme" dangerouslySetInnerHTML={{ __html: getThemeScript() }} />
      </head>
      <body className="min-h-screen bg-bg text-fg antialiased">
        <AppFrame user={user} tenant={tenant} switchTenant={switchTenantAction} allowedSections={allowedSections}>
          {children}
        </AppFrame>
        <SplashScreen />
        <PromptRoot />
        <ConfirmRoot />
        <Toaster richColors closeButton />
      </body>
    </html>
  )
}
