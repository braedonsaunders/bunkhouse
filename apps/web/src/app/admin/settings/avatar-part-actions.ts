'use server'

import { revalidatePath } from 'next/cache'
import { resolveTenantId } from '../../../lib/tenant'
import {
  deleteAvatarPart,
  generateAvatarPartCandidates,
  renameAvatarPart,
  saveAvatarPart,
} from '../../../lib/avatars'

/** Everything that reads the parts library after it changes. */
function revalidateLibrary(): void {
  revalidatePath('/admin/settings')
  revalidatePath('/organization/people')
  revalidatePath('/organization')
  revalidatePath('/organization/chart')
  revalidatePath('/')
}

export async function generateAvatarPartsAction(
  categoryId: string,
  description: string,
): Promise<{ ok: true; images: string[]; model: string; prompt: string } | { ok: false; message: string }> {
  try {
    const tenantId = await resolveTenantId()
    const result = await generateAvatarPartCandidates({ tenantId, categoryId, description })
    return { ok: true, ...result }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export async function keepAvatarPartAction(args: {
  categoryId: string
  name: string
  dataUri: string
  model: string
  prompt: string
  colorVariant?: string
  tags: string[]
}): Promise<{ ok: true; partId: string } | { ok: false; message: string }> {
  try {
    const tenantId = await resolveTenantId()
    const partId = await saveAvatarPart({ tenantId, ...args })
    revalidateLibrary()
    return { ok: true, partId }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export async function updateAvatarPartAction(args: {
  partId: string
  name: string
  tags: string[]
}): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const tenantId = await resolveTenantId()
    await renameAvatarPart({ tenantId, ...args })
    revalidateLibrary()
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export async function deleteAvatarPartAction(
  partId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const tenantId = await resolveTenantId()
    await deleteAvatarPart(tenantId, partId)
    revalidateLibrary()
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
