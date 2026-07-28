import 'server-only'
import { eq } from 'drizzle-orm'
import { schema as identity } from '@appkit/db'
import { db } from '../db/client'

/**
 * Tenant resolution, pre-auth. Until the @appkit/auth session slice lands,
 * the app runs against the sole active tenant — an explicit bootstrap rule,
 * not a fallback: with zero or multiple tenants it refuses loudly rather
 * than guessing. Auth replaces this function wholesale; every caller already
 * goes through it.
 */
export async function resolveTenantId(): Promise<string> {
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
    throw new Error('Multiple tenants exist; sign-in is required to choose one. Configure auth before adding tenants.')
  }
  return active[0]!.id
}
