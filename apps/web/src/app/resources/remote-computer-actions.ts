'use server'

import { revalidatePath } from 'next/cache'
import {
  disableRemoteComputer,
  saveRemoteComputer,
  testRemoteComputer,
  type RemoteComputerInput,
} from '../../lib/remote-computers'
import { requireTenantPermission } from '../../lib/tenant'

export async function saveRemoteComputerAction(input: RemoteComputerInput): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const access = await requireTenantPermission('resources.manage')
    await saveRemoteComputer(access.tenantId, access.user.id, input)
    revalidatePath('/resources')
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export async function testRemoteComputerAction(id: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const access = await requireTenantPermission('resources.manage')
    await testRemoteComputer(access.tenantId, id)
    revalidatePath('/resources')
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export async function disableRemoteComputerAction(id: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const access = await requireTenantPermission('resources.manage')
    await disableRemoteComputer(access.tenantId, access.user.id, id)
    revalidatePath('/resources')
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
