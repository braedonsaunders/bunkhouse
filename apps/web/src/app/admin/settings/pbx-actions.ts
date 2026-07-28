'use server'

import { revalidatePath } from 'next/cache'
import { assignExtension, assignPhoneNumber, createSipTrunk, deleteSipTrunk, removePhoneNumber, updateSipTrunk, type SipTrunkInput } from '../../../lib/pbx'
import { resolveTenantId } from '../../../lib/tenant'

export type SipTrunkFormInput = {
  id?: string
  name: string
  flavor: 'avaya_ip_office' | 'generic_sip'
  pbxHost: string
  pbxPort: string
  transport: 'udp' | 'tcp' | 'tls'
  authUsername: string
  /** Empty string clears the stored password; undefined leaves it sealed. */
  authPassword?: string
  extensionRange: string
}

/** Create or update a PBX trunk; the row is re-mirrored to the SIP ingress. */
export async function saveSipTrunkAction(
  input: SipTrunkFormInput,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const name = input.name.trim()
  if (!name) return { ok: false, message: 'Give the trunk a name.' }
  const port = input.pbxPort.trim() ? Number(input.pbxPort) : 5060
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, message: 'Port must be a number between 1 and 65535.' }
  }
  const payload: SipTrunkInput = {
    name,
    flavor: input.flavor,
    pbxHost: input.pbxHost,
    pbxPort: port,
    transport: input.transport,
    authUsername: input.authUsername,
    ...(input.authPassword !== undefined ? { authPassword: input.authPassword } : {}),
    extensionRange: input.extensionRange,
  }
  try {
    const tenantId = await resolveTenantId()
    if (input.id) await updateSipTrunk(tenantId, input.id, payload)
    else await createSipTrunk(tenantId, payload)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  revalidatePath('/admin/settings')
  return { ok: true }
}

/** Remove a trunk and its mirrored SIP ingress objects. */
export async function deleteSipTrunkAction(trunkId: string): Promise<void> {
  const tenantId = await resolveTenantId()
  await deleteSipTrunk(tenantId, trunkId)
  revalidatePath('/admin/settings')
}

/** Set or clear an agent's phone extension (unique per company). */
export async function setAgentExtensionAction(input: {
  personId: string
  extension: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const tenantId = await resolveTenantId()
  const result = await assignExtension({
    tenantId,
    personId: input.personId,
    extension: input.extension.trim() || null,
  })
  if (result.ok) {
    revalidatePath('/organization/agents')
    revalidatePath('/admin/settings')
  }
  return result
}

/** Point a real phone number at an agent (carrier path). */
export async function assignPhoneNumberAction(input: {
  number: string
  label: string
  personId: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const tenantId = await resolveTenantId()
  const result = await assignPhoneNumber({ tenantId, ...input })
  if (result.ok) revalidatePath('/admin/settings')
  return result
}

export async function removePhoneNumberAction(numberId: string): Promise<void> {
  const tenantId = await resolveTenantId()
  await removePhoneNumber(tenantId, numberId)
  revalidatePath('/admin/settings')
}
