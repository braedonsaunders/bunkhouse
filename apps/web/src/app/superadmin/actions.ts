'use server'

import { revalidatePath } from 'next/cache'
import { hashPassword } from 'better-auth/crypto'
import { createDrizzleSuperadminService } from '@braedonsaunders/appkit-superadmin/drizzle'
import type { SuperadminService } from '@braedonsaunders/appkit-superadmin'
import type { SuperadminActionResult } from '@braedonsaunders/appkit-superadmin/react'
import { requireSuperAdmin } from '../../lib/auth'
import { provisionTenant, resolveTenantId } from '../../lib/tenant'
import { ensurePersonForMembership } from '../../lib/person-accounts'
import { db } from '../../db/client'

// Instance-operator actions. Every entry point re-authorizes via
// requireSuperAdmin() — the client-side nav gating is cosmetic only. The
// identity tables are global (no tenant scope), so the service runs on the
// BYPASSRLS handle, exactly like the auth runtime itself.

async function operatorService(): Promise<SuperadminService> {
  const operator = await requireSuperAdmin()
  // The operator's current tenant powers the suspend-your-own-workspace flag
  // and is where newly created accounts get their membership.
  const tenantId = await resolveTenantId()
  return createDrizzleSuperadminService({
    db: db().superDb,
    hashPassword,
    actor: { userId: operator.userId, sessionId: operator.sessionId, tenantId },
  })
}

function failure(error: unknown): SuperadminActionResult {
  return { ok: false, message: error instanceof Error ? error.message : String(error) }
}

export async function createPlatformUserAction(input: {
  name: string
  email: string
  password: string
  isSuperAdmin?: boolean
  tenantId: string
}): Promise<SuperadminActionResult> {
  try {
    const service = await operatorService()
    // Identity is global; membership is app-level. A user who cannot reach any
    // workspace is stranded, so the drawer picks the workspace explicitly and
    // the account joins it here. Validate before creating the account so a bad
    // choice never leaves a stranded identity behind.
    const { tenantId, ...userInput } = input
    const tenant = await service.getTenant(tenantId)
    if (!tenant) return { ok: false, message: 'The chosen workspace no longer exists.' }
    if (tenant.status !== 'active') {
      return { ok: false, message: `${tenant.name} is not active — reactivate it before adding members.` }
    }
    const created = await service.createUser(userInput)
    const member = await service.addTenantMember(tenantId, { email: created.email })
    await ensurePersonForMembership({ tenantId, userId: member.userId, actorUserId: (await requireSuperAdmin()).userId })
    revalidatePath('/superadmin')
    return { ok: true }
  } catch (error) {
    return failure(error)
  }
}

export async function updatePlatformUserAction(
  userId: string,
  input: { name?: string; isActive?: boolean; isSuperAdmin?: boolean; emailVerified?: boolean },
): Promise<SuperadminActionResult> {
  try {
    const service = await operatorService()
    await service.updateUser(userId, input)
    revalidatePath('/superadmin')
    return { ok: true }
  } catch (error) {
    return failure(error)
  }
}

export async function setPlatformUserPasswordAction(
  userId: string,
  password: string,
): Promise<SuperadminActionResult> {
  try {
    const service = await operatorService()
    await service.setPassword(userId, password)
    revalidatePath('/superadmin')
    return { ok: true }
  } catch (error) {
    return failure(error)
  }
}

export async function revokePlatformUserSessionsAction(userId: string): Promise<SuperadminActionResult> {
  try {
    const service = await operatorService()
    const result = await service.revokeUserSessions(userId)
    revalidatePath('/superadmin')
    return {
      ok: true,
      ...(result.revokedCurrentSession
        ? { message: 'All sessions ended — including your current one, so you will be signed out.' }
        : {}),
    }
  } catch (error) {
    return failure(error)
  }
}

export async function createPlatformTenantAction(input: {
  name: string
  slug: string
}): Promise<SuperadminActionResult> {
  try {
    const service = await operatorService()
    const tenant = await service.createTenant(input)
    // Run the app-level bootstrap so the new workspace is immediately usable.
    await provisionTenant(tenant.id)
    revalidatePath('/superadmin')
    return { ok: true }
  } catch (error) {
    return failure(error)
  }
}

export async function setPlatformTenantStatusAction(
  tenantId: string,
  status: 'active' | 'suspended',
): Promise<SuperadminActionResult> {
  try {
    const service = await operatorService()
    const result = await service.setTenantStatus(tenantId, status)
    revalidatePath('/superadmin')
    return {
      ok: true,
      ...(result.suspendedCurrentTenant
        ? {
            message:
              'You suspended the workspace you are currently working in — you will land in another workspace (or none) on the next page load.',
          }
        : {}),
    }
  } catch (error) {
    return failure(error)
  }
}

export async function addPlatformTenantMemberAction(
  tenantId: string,
  email: string,
): Promise<SuperadminActionResult> {
  try {
    const service = await operatorService()
    const member = await service.addTenantMember(tenantId, { email })
    await ensurePersonForMembership({ tenantId, userId: member.userId, actorUserId: (await requireSuperAdmin()).userId })
    revalidatePath('/superadmin')
    return { ok: true }
  } catch (error) {
    return failure(error)
  }
}

export async function setPlatformTenantMemberStatusAction(
  tenantId: string,
  membershipId: string,
  status: 'active' | 'suspended',
): Promise<SuperadminActionResult> {
  try {
    const service = await operatorService()
    const member = await service.setTenantMemberStatus(tenantId, membershipId, status)
    if (status === 'active') {
      await ensurePersonForMembership({ tenantId, userId: member.userId, actorUserId: (await requireSuperAdmin()).userId })
    }
    revalidatePath('/superadmin')
    return { ok: true }
  } catch (error) {
    return failure(error)
  }
}

export async function removePlatformTenantMemberAction(
  tenantId: string,
  membershipId: string,
): Promise<SuperadminActionResult> {
  try {
    const service = await operatorService()
    await service.removeTenantMember(tenantId, membershipId)
    revalidatePath('/superadmin')
    return { ok: true }
  } catch (error) {
    return failure(error)
  }
}

export async function revokePlatformSessionAction(sessionId: string): Promise<SuperadminActionResult> {
  try {
    const service = await operatorService()
    const result = await service.revokeSession(sessionId)
    revalidatePath('/superadmin')
    return {
      ok: true,
      ...(result.revokedCurrentSession
        ? { message: 'You revoked your current session and will be signed out.' }
        : {}),
    }
  } catch (error) {
    return failure(error)
  }
}
