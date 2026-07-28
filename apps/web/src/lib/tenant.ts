import 'server-only'
import { cache } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { and, asc, eq, sql } from 'drizzle-orm'
import { schema as identity } from '@appkit/db'
import { db } from '../db/client'
import { getSessionUser, requireUser, type SessionUser } from './auth'

/**
 * Membership-based tenant resolution. Every request path resolves the current
 * tenant from the signed-in user's ACTIVE memberships; a multi-membership user
 * carries an httpOnly cookie naming their chosen tenant, and that cookie is
 * validated against the membership set on every read — it is a preference,
 * never an authorization.
 */

/** httpOnly workspace-choice cookie. Validated against membership on every read. */
export const TENANT_COOKIE = 'bunkhouse_tenant'

export type TenantOption = { id: string; name: string }

export type TenantSelection = {
  /** The tenant this request operates in, or null when the user has no workspace. */
  current: TenantOption | null
  /** Active memberships in active tenants — the only tenants the user may switch to. */
  options: TenantOption[]
}

/** Oldest active tenant — the installation's bootstrap tenant. */
async function bootstrapTenant(): Promise<TenantOption | null> {
  const app = db()
  const [tenant] = await app.withSuperAdmin((superDb) =>
    superDb
      .select({ id: identity.tenants.id, name: identity.tenants.name })
      .from(identity.tenants)
      .where(eq(identity.tenants.status, 'active'))
      .orderBy(asc(identity.tenants.createdAt), asc(identity.tenants.id))
      .limit(1),
  )
  return tenant ?? null
}

/** The user's active memberships in active tenants, oldest tenant first. */
async function membershipOptions(userId: string): Promise<TenantOption[]> {
  const app = db()
  return app.withSuperAdmin((superDb) =>
    superDb
      .select({ id: identity.tenants.id, name: identity.tenants.name })
      .from(identity.memberships)
      .innerJoin(identity.tenants, eq(identity.tenants.id, identity.memberships.tenantId))
      .where(
        and(
          eq(identity.memberships.userId, userId),
          eq(identity.memberships.status, 'active'),
          eq(identity.tenants.status, 'active'),
        ),
      )
      .orderBy(asc(identity.tenants.createdAt), asc(identity.tenants.id)),
  )
}

/**
 * The full selection for the signed-in user. Memoized per request. The cookie
 * only ever picks BETWEEN the user's own memberships; a tampered or stale
 * cookie value falls back to the first membership, silently and safely.
 * Super admins with no membership anywhere administer the instance, so they
 * fall back to the bootstrap tenant (with no switcher — options stays empty).
 */
export const getTenantSelection = cache(async (user: SessionUser): Promise<TenantSelection> => {
  const options = await membershipOptions(user.id)
  if (options.length === 0) {
    if (user.isSuperAdmin) return { current: await bootstrapTenant(), options: [] }
    return { current: null, options: [] }
  }
  const cookieValue = (await cookies()).get(TENANT_COOKIE)?.value
  const current = options.find((option) => option.id === cookieValue) ?? options[0]!
  return { current, options }
})

/**
 * Tenant resolution for request paths (RSCs, server actions, route handlers).
 * Validates the Better Auth session first — this is the real enforcement
 * behind the middleware's cookie-presence gate: every data path goes through
 * here, so an unauthenticated request never touches tenant data. A user with
 * no workspace is sent to a clear explanation screen instead of an error.
 */
export async function resolveTenantId(): Promise<string> {
  const user = await requireUser()
  const { current } = await getTenantSelection(user)
  if (!current) redirect('/no-workspace')
  return current.id
}

/**
 * Non-throwing selection for chrome (layout, account menu): null when signed
 * out, `current: null` when the user has no workspace. Never redirects.
 */
export async function getTenantSelectionForChrome(): Promise<TenantSelection | null> {
  const user = await getSessionUser()
  if (!user) return null
  return getTenantSelection(user)
}

/**
 * Tenant resolution for background processes (worker, voice agent, dev
 * scripts) that have no request context and therefore no session to validate.
 * Resolves the bootstrap tenant (oldest active) as the system default; jobs
 * that must span every tenant iterate activeTenantIds() instead. Never call
 * this from a request path.
 */
export async function resolveTenantIdForSystem(): Promise<string> {
  const tenant = await bootstrapTenant()
  if (!tenant) {
    throw new Error('No tenant exists — run `pnpm --filter web db:seed` to bootstrap the company.')
  }
  return tenant.id
}

/**
 * Boot-time backfill: every ACTIVE user without any membership row gets an
 * active membership in the bootstrap tenant. Covers the owner account and any
 * user created before memberships were wired; idempotent, so it runs on every
 * boot from the instrumentation hook. New users created through Platform →
 * Users get their membership at creation time instead.
 */
export async function ensureMembershipBackfill(): Promise<void> {
  const tenant = await bootstrapTenant()
  if (!tenant) return
  const app = db()
  await app.withSuperAdmin(async (superDb) => {
    const orphans = await superDb
      .select({ id: identity.users.id, name: identity.users.name })
      .from(identity.users)
      .where(
        and(
          eq(identity.users.isActive, true),
          sql`not exists (select 1 from tenant_users tu where tu.user_id = ${identity.users.id})`,
        ),
      )
    for (const user of orphans) {
      await superDb
        .insert(identity.memberships)
        .values({
          tenantId: tenant.id,
          userId: user.id,
          displayName: user.name,
          status: 'active',
          joinedAt: new Date(),
        })
        .onConflictDoNothing()
    }
    if (orphans.length > 0) {
      console.log(`[tenant] backfilled ${orphans.length} membership(s) into the bootstrap tenant.`)
    }
  })
}

/**
 * Per-tenant provisioning, run when a tenant is created so it is immediately
 * usable. Today a fresh Bunkhouse tenant needs no seeded rows: role packs and
 * avatar part categories are code constants, and the parts library, settings,
 * and directory deliberately start empty. This is the single hook where any
 * future per-tenant bootstrap (built-in roles, default settings) belongs.
 */
export async function provisionTenant(tenantId: string): Promise<void> {
  const app = db()
  const [tenant] = await app.withSuperAdmin((superDb) =>
    superDb
      .select({ id: identity.tenants.id })
      .from(identity.tenants)
      .where(eq(identity.tenants.id, tenantId))
      .limit(1),
  )
  if (!tenant) throw new Error(`Cannot provision missing tenant: ${tenantId}`)
}
