'use server'

import { cookies } from 'next/headers'
import { requireUser } from '../lib/auth'
import { getTenantSelection, TENANT_COOKIE } from '../lib/tenant'

/**
 * Workspace switch: records the choice in the httpOnly tenant cookie. The
 * cookie is a preference, not an authorization — it is validated against the
 * caller's active memberships here AND on every subsequent read in
 * getTenantSelection, so a tampered value can never reach another tenant.
 */
export async function switchTenantAction(tenantId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const user = await requireUser()
  const { options } = await getTenantSelection(user)
  if (!options.some((option) => option.id === tenantId)) {
    return { ok: false, message: 'You are not a member of that workspace.' }
  }
  const store = await cookies()
  store.set(TENANT_COOKIE, tenantId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 365,
  })
  return { ok: true }
}
