'use server'

import { revalidatePath } from 'next/cache'
import { hashPassword } from 'better-auth/crypto'
import { createDrizzleSuperadminService } from '@appkit/superadmin/drizzle'
import type { SuperadminService } from '@appkit/superadmin'
import type { SuperadminActionResult } from '@appkit/superadmin/react'
import { requireSuperAdmin } from '../../../lib/auth'
import { db } from '../../../db/client'

// Instance-operator actions. Every entry point re-authorizes via
// requireSuperAdmin() — the client-side nav gating is cosmetic only. The
// identity tables are global (no tenant scope), so the service runs on the
// BYPASSRLS handle, exactly like the auth runtime itself.

async function operatorService(): Promise<SuperadminService> {
  const operator = await requireSuperAdmin()
  return createDrizzleSuperadminService({
    db: db().superDb,
    hashPassword,
    actor: { userId: operator.userId, sessionId: operator.sessionId },
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
}): Promise<SuperadminActionResult> {
  try {
    const service = await operatorService()
    await service.createUser(input)
    revalidatePath('/admin/settings')
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
    revalidatePath('/admin/settings')
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
    revalidatePath('/admin/settings')
    return { ok: true }
  } catch (error) {
    return failure(error)
  }
}

export async function revokePlatformUserSessionsAction(userId: string): Promise<SuperadminActionResult> {
  try {
    const service = await operatorService()
    const result = await service.revokeUserSessions(userId)
    revalidatePath('/admin/settings')
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

export async function revokePlatformSessionAction(sessionId: string): Promise<SuperadminActionResult> {
  try {
    const service = await operatorService()
    const result = await service.revokeSession(sessionId)
    revalidatePath('/admin/settings')
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
