'use server'

import { revalidatePath } from 'next/cache'
import type { AvatarComposition } from '@appkit/avatars/composition'
import { resolveTenantId } from '../../lib/tenant'
import { saveAvatarComposition } from '../../lib/avatars'

/**
 * Save a person's figure.
 *
 * One composition per person — the portrait, the standing figure in the lobby,
 * and the face on a call are all this document rendered through different
 * viewports, so this is the only avatar write in the product.
 */
export async function saveAvatarCompositionAction(
  personId: string,
  composition: AvatarComposition,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const tenantId = await resolveTenantId()
    await saveAvatarComposition({ tenantId, personId, composition })
    revalidatePath('/organization/people')
    revalidatePath('/organization/agents')
    revalidatePath('/organization/chart')
    revalidatePath('/')
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
