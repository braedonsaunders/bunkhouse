import 'server-only'
import { cache } from 'react'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { createAppkitAuth, createLazyAuth } from '@braedonsaunders/appkit-auth/server'
import { APIError } from 'better-auth/api'
import { schema as identity } from '@braedonsaunders/appkit-db'
import { db } from '../db/client'

// Authentication for bunkhouse: @braedonsaunders/appkit-auth (Better Auth) over the shared
// Postgres cluster. Sessions, users, accounts, and verifications live in the
// GLOBAL identity tables (0001_identity.sql / 0019_auth.sql) — auth is
// cross-tenant infrastructure, so it runs on the BYPASSRLS super pool; the
// tenant-scoped pool would be pointlessly ceremonial here (the auth tables
// carry no tenant_id) and its per-query GUC wrapper only adds latency.

function requiredSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret || secret.length < 32) {
    throw new Error(
      'BETTER_AUTH_SECRET must be set to a random value of at least 32 characters (.env.local in dev; deployment environment in production).',
    )
  }
  return secret
}

export const getAuth = createLazyAuth(() =>
  createAppkitAuth({
    database: db().superPool,
    baseURL: process.env.APP_URL ?? 'http://localhost:4810',
    secret: requiredSecret(),
    appName: 'Bunkhouse',
    // No invite/reset delivery this slice: auth mail is logged, not sent.
    // Password sign-in works without it; wire real transport with invites.
    sendEmail: async (message) => {
      console.log(`[auth] email suppressed (no transport configured): ${message.kind} → ${message.to}`)
    },
    extend: {
      // A deactivated account must not be able to sign in: sessions are
      // created on every successful credential/magic-link verification, so
      // refusing session creation here closes the front door regardless of
      // sign-in method. (The superadmin panel separately revokes any live
      // sessions when it deactivates an account.)
      databaseHooks: {
        session: {
          create: {
            before: async (session) => {
              const [row] = await db().withSuperAdmin((superDb) =>
                superDb
                  .select({ isActive: identity.users.isActive })
                  .from(identity.users)
                  .where(eq(identity.users.id, session.userId))
                  .limit(1),
              )
              if (!row?.isActive) {
                throw new APIError('FORBIDDEN', {
                  message: 'This account has been deactivated. Contact an administrator.',
                })
              }
              return { data: session }
            },
          },
        },
      },
    },
  }),
)

export type SessionUser = {
  id: string
  name: string
  email: string
  /**
   * Platform super-admin standing as recorded on the session's user. Used for
   * chrome (whether operator navigation renders); enforcement on data paths
   * re-checks the database via requireSuperAdmin().
   */
  isSuperAdmin: boolean
}

/**
 * The signed-in user from the Better Auth session, or null. Non-throwing —
 * chrome (layout, account menu) uses this; data paths use requireUser().
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const session = await getAuth().api.getSession({ headers: await headers() })
    if (!session?.user) return null
    return sessionUserOf(session.user)
  } catch {
    return null
  }
}

function sessionUserOf(user: { id: string; name?: string | null; email: string }): SessionUser {
  return {
    id: user.id,
    name: user.name ?? '',
    email: user.email,
    isSuperAdmin: Boolean((user as Record<string, unknown>).isSuperAdmin),
  }
}

/**
 * Real server-side session validation for every data path. The middleware's
 * cookie-presence check only shapes navigation; THIS is the enforcement:
 * resolveTenantId() calls it, and every server action / RSC data path goes
 * through resolveTenantId. Memoized per request via React cache().
 */
export const requireUser = cache(async (): Promise<SessionUser> => {
  const session = await getAuth().api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')
  return sessionUserOf(session.user)
})

/** The acting operator for instance administration. */
export type SuperAdminContext = {
  userId: string
  name: string
  email: string
  /** The operator's own session id, so self-revocation can be flagged, never silent. */
  sessionId: string
}

/**
 * Instance-operator gate. Unlike the isSuperAdmin flag on SessionUser (session
 * snapshot, cookie-cached), this re-reads the users table so a mid-session
 * demotion or deactivation takes effect immediately. Every platform-admin
 * server action and data path MUST go through this; nav visibility alone is
 * cosmetic. Returns null when the caller is signed out or not a super admin.
 */
export const getSuperAdminContext = cache(async (): Promise<SuperAdminContext | null> => {
  const session = await getAuth().api.getSession({ headers: await headers() })
  if (!session?.user) return null
  const [row] = await db().withSuperAdmin((superDb) =>
    superDb
      .select({ isActive: identity.users.isActive, isSuperAdmin: identity.users.isSuperAdmin })
      .from(identity.users)
      .where(eq(identity.users.id, session.user.id))
      .limit(1),
  )
  if (!row?.isActive || !row.isSuperAdmin) return null
  return {
    userId: session.user.id,
    name: session.user.name ?? '',
    email: session.user.email,
    sessionId: session.session.id,
  }
})

/** Throwing variant for server actions: super admin or the operation fails. */
export async function requireSuperAdmin(): Promise<SuperAdminContext> {
  const context = await getSuperAdminContext()
  if (!context) throw new Error('Super-admin access is required for platform administration.')
  return context
}

/**
 * First-boot owner. When no credentialed account exists at all — a fresh
 * database, or one seeded before auth shipped (the seed created users without
 * credentials) — create/repair the owner login from ADMIN_EMAIL +
 * ADMIN_PASSWORD. Uses Better Auth's own password hasher so the stored hash
 * is exactly what sign-in verifies. Once any credentialed account exists this
 * never runs again, so it cannot fight later user management. Invoked from
 * the instrumentation hook at server boot; never logs the password.
 */
export async function ensureOwnerAccount(): Promise<void> {
  const app = db()
  const anyCredential = await app.withSuperAdmin((superDb) =>
    superDb
      .select({ id: identity.authAccounts.id })
      .from(identity.authAccounts)
      .where(eq(identity.authAccounts.providerId, 'credential'))
      .limit(1),
  )
  if (anyCredential.length > 0) return

  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase()
  const password = process.env.ADMIN_PASSWORD
  if (!email || !password) {
    console.warn(
      '[auth] No sign-in credential exists and ADMIN_EMAIL / ADMIN_PASSWORD are not set — nobody can sign in until they are configured and the server restarts.',
    )
    return
  }

  const authContext = await getAuth().$context
  const passwordHash = await authContext.password.hash(password)

  await app.withSuperAdmin(async (superDb) => {
    const [existing] = await superDb
      .select({ id: identity.users.id })
      .from(identity.users)
      .where(eq(identity.users.email, email))
      .limit(1)

    let userId = existing?.id
    if (!userId) {
      const [created] = await superDb
        .insert(identity.users)
        .values({ email, name: 'Owner', emailVerified: true, isActive: true, isSuperAdmin: true })
        .returning({ id: identity.users.id })
      userId = created!.id
    } else {
      await superDb
        .update(identity.users)
        .set({ emailVerified: true, isActive: true, isSuperAdmin: true, updatedAt: new Date() })
        .where(eq(identity.users.id, userId))
    }

    await superDb.insert(identity.authAccounts).values({
      userId,
      providerId: 'credential',
      accountId: userId,
      password: passwordHash,
    })
  })
  console.log(`[auth] Owner account provisioned for ${email} (password from ADMIN_PASSWORD).`)
}
