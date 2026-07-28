import 'server-only'
import { eq } from 'drizzle-orm'
import { schema as identity } from '@appkit/db'
import { db } from '../db/client'
import { requireUser } from './auth'

/**
 * Single-tenant bootstrap rule: the app runs against the sole active tenant.
 * With zero or multiple tenants it refuses loudly rather than guessing —
 * multi-tenant membership resolution replaces this, not a fallback.
 */
async function soleActiveTenantId(): Promise<string> {
  const app = db()
  const active = await app.withSuperAdmin((superDb) =>
    superDb
      .select({ id: identity.tenants.id })
      .from(identity.tenants)
      .where(eq(identity.tenants.status, 'active')),
  )
  if (active.length === 0) {
    throw new Error('No tenant exists — run `pnpm --filter web db:seed` to bootstrap the company.')
  }
  if (active.length > 1) {
    throw new Error('Multiple tenants exist; membership-based tenant selection is required. Keep a single tenant until it ships.')
  }
  return active[0]!.id
}

/**
 * Tenant resolution for request paths (RSCs, server actions, route handlers).
 * Validates the Better Auth session first — this is the real enforcement
 * behind the middleware's cookie-presence gate: every data path goes through
 * here, so an unauthenticated request never touches tenant data. Any
 * authenticated user gets the sole tenant; membership checks come with
 * multi-tenancy.
 */
export async function resolveTenantId(): Promise<string> {
  await requireUser()
  return soleActiveTenantId()
}

/**
 * Tenant resolution for background processes (worker, voice agent, dev
 * scripts) that have no request context and therefore no session to validate.
 * Never call this from a request path.
 */
export async function resolveTenantIdForSystem(): Promise<string> {
  return soleActiveTenantId()
}
