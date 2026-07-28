import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { eq } from 'drizzle-orm'
import { ConfirmRoot, getThemeScript, PromptRoot, Toaster } from '@appkit/ui'
import { schema as identity } from '@appkit/db'
import { AppFrame } from '@/components/app-frame'
import { getSessionUser } from '@/lib/auth'
import { db } from '@/db/client'
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
  let contextLabel: string | undefined
  if (user) {
    const [tenant] = await db().withSuperAdmin((superDb) =>
      superDb
        .select({ name: identity.tenants.name })
        .from(identity.tenants)
        .where(eq(identity.tenants.status, 'active'))
        .limit(1),
    )
    contextLabel = tenant ? `${tenant.name} · workspace` : undefined
  }
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script id="appkit-theme" dangerouslySetInnerHTML={{ __html: getThemeScript() }} />
      </head>
      <body className="min-h-screen bg-bg text-fg antialiased">
        <AppFrame user={user} contextLabel={contextLabel}>
          {children}
        </AppFrame>
        <PromptRoot />
        <ConfirmRoot />
        <Toaster richColors closeButton />
      </body>
    </html>
  )
}
