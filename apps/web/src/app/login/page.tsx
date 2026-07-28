import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth'
import { LoginForm } from './login-form'

export const metadata: Metadata = {
  title: 'Sign in · Bunkhouse',
}

export default async function LoginPage() {
  // Already signed in → straight to the floor.
  if (await getSessionUser()) redirect('/')
  return <LoginForm />
}
