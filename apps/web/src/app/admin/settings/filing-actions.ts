'use server'

import { revalidatePath } from 'next/cache'
import { resolveTenantId } from '../../../lib/tenant'
import {
  disconnectFilingTarget,
  removeFilingApp,
  saveFilingApp,
  saveFilingDirectory,
  saveFilingOptions,
  validateFilingDirectory,
  type FilingFileKind,
  type FilingLayout,
  type FilingOauthProvider,
} from '../../../lib/filing'

/**
 * Server actions for Settings → Filing. Credentials never round-trip to the
 * browser: a client secret is posted once and sealed, and everything rendered
 * afterwards is the application's identity, not its secret.
 */

const FILING_PATH = '/admin/settings/filing'

type Result = { ok: true } | { ok: false; message: string }

function failure(error: unknown): { ok: false; message: string } {
  return { ok: false, message: error instanceof Error ? error.message : String(error) }
}

export async function saveFilingAppAction(input: {
  provider: FilingOauthProvider
  clientId: string
  clientSecret: string
  directory?: string
}): Promise<Result> {
  try {
    const tenantId = await resolveTenantId()
    await saveFilingApp({
      tenantId,
      provider: input.provider,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      ...(input.directory ? { directory: input.directory } : {}),
    })
    revalidatePath(FILING_PATH)
    return { ok: true }
  } catch (error) {
    return failure(error)
  }
}

export async function removeFilingAppAction(input: { provider: FilingOauthProvider }): Promise<Result> {
  try {
    const tenantId = await resolveTenantId()
    await removeFilingApp(tenantId, input.provider)
    revalidatePath(FILING_PATH)
    return { ok: true }
  } catch (error) {
    return failure(error)
  }
}

export async function saveFilingOptionsAction(input: {
  enabled: boolean
  kinds: FilingFileKind[]
  layout: FilingLayout
}): Promise<Result> {
  try {
    const tenantId = await resolveTenantId()
    await saveFilingOptions({ tenantId, enabled: input.enabled, kinds: input.kinds, layout: input.layout })
    revalidatePath(FILING_PATH)
    return { ok: true }
  } catch (error) {
    return failure(error)
  }
}

/** Check a mounted folder without saving it — the operator's "does this work?" button. */
export async function checkFilingDirectoryAction(input: { basePath: string }): Promise<Result> {
  try {
    // Session-gated like every other action here, even though the check reads
    // no tenant data — probing the container's filesystem is not public.
    await resolveTenantId()
    const check = await validateFilingDirectory(input.basePath)
    return check.ok ? { ok: true } : { ok: false, message: check.message }
  } catch (error) {
    return failure(error)
  }
}

export async function saveFilingDirectoryAction(input: { basePath: string; label?: string }): Promise<Result> {
  try {
    const tenantId = await resolveTenantId()
    await saveFilingDirectory({
      tenantId,
      basePath: input.basePath,
      ...(input.label ? { label: input.label } : {}),
    })
    revalidatePath(FILING_PATH)
    return { ok: true }
  } catch (error) {
    return failure(error)
  }
}

export async function disconnectFilingTargetAction(): Promise<Result> {
  try {
    const tenantId = await resolveTenantId()
    await disconnectFilingTarget(tenantId)
    revalidatePath(FILING_PATH)
    return { ok: true }
  } catch (error) {
    return failure(error)
  }
}
