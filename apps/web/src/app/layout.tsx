import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { ConfirmRoot, getThemeScript, PromptRoot, Toaster } from '@appkit/ui'
import { AppFrame } from '@/components/app-frame'
import './globals.css'

export const metadata: Metadata = {
  title: 'Web',
  description: 'Built with AppKit',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script id="appkit-theme" dangerouslySetInnerHTML={{ __html: getThemeScript() }} />
      </head>
      <body className="min-h-screen bg-bg text-fg antialiased">
        <AppFrame>{children}</AppFrame>
        <PromptRoot />
        <ConfirmRoot />
        <Toaster richColors closeButton />
      </body>
    </html>
  )
}
