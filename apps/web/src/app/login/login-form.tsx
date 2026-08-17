'use client'

import { AuthScreen, SignInForm } from '@braedonsaunders/appkit-auth/react'
import { authClient } from '@/lib/auth-client'
import { Logo } from '@/components/brand-logo'

// The package's sign-in composition, themed by the app (AuthScreen renders on
// the design tokens the AppShell already uses). No self-serve sign-up:
// accounts are provisioned by an administrator.

export function LoginForm() {
  return (
    <AuthScreen
      logo={<Logo size={24} className="text-fg" />}
      title="Sign in to your workspace"
      description="Manage your company's AI employees."
      footer="Accounts are created by your administrator — there is no self-serve sign-up."
    >
      <SignInForm
        signInWithPassword={async ({ email, password }) => {
          const result = await authClient.signIn.email({ email, password })
          return { error: result.error ? (result.error.message ?? 'Sign-in failed.') : null }
        }}
        signInWithMagicLink={async () => ({
          error: 'Email-link sign-in is not available yet. Use your password.',
        })}
        // Full navigation, not a client transition: the root layout resolved
        // the (null) session during the /login render and persists across
        // client routing — a fresh document render picks up the new session.
        onSignedIn={() => window.location.assign('/')}
        forgotPasswordHref="/login"
        labels={{ forgotPassword: 'Forgot password? Ask your administrator.' }}
      />
    </AuthScreen>
  )
}
