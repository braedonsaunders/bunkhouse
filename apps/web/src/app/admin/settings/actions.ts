'use server'

import { revalidatePath } from 'next/cache'
import { isAiProvider, listModels } from '@appkit/ai'
import { unsealSecret } from '@appkit/crypto'
import { addAiProvider, listAiProviders, removeAiProvider } from '../../../lib/ai'
import { resolveTenantId } from '../../../lib/tenant'
import { refreshPricesFromOpenRouter, setManualPrice } from '../../../lib/pricing'
import { setImageProviderSetting } from '../../../lib/avatars'
import { type ImageModelId } from '@appkit/avatars'

export async function addProviderAction(formData: FormData): Promise<void> {
  const slug = String(formData.get('slug') ?? '').trim().toLowerCase()
  const provider = String(formData.get('provider') ?? '')
  const label = String(formData.get('label') ?? '').trim() || slug
  const apiKey = String(formData.get('apiKey') ?? '').trim()
  const baseUrl = String(formData.get('baseUrl') ?? '').trim()
  const modelSmart = String(formData.get('modelSmart') ?? '').trim()
  const modelFast = String(formData.get('modelFast') ?? '').trim()
  if (!slug || !provider || !apiKey) throw new Error('Slug, provider kind, and API key are required.')

  const tenantId = await resolveTenantId()
  await addAiProvider({
    tenantId,
    slug,
    provider,
    label,
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(modelSmart ? { modelSmart } : {}),
    ...(modelFast ? { modelFast } : {}),
  })
  revalidatePath('/settings')
}

export async function removeProviderAction(formData: FormData): Promise<void> {
  const slug = String(formData.get('slug') ?? '')
  if (!slug) throw new Error('slug is required')
  const tenantId = await resolveTenantId()
  await removeAiProvider(tenantId, slug)
  revalidatePath('/settings')
}

/** Live model discovery for a key being entered (nothing is stored yet). */
export async function loadModelsAction(input: {
  provider: string
  apiKey: string
  baseUrl?: string
}): Promise<{ ok: true; models: { id: string; label?: string }[] } | { ok: false; message: string }> {
  if (!isAiProvider(input.provider)) return { ok: false, message: `Unknown provider kind: ${input.provider}` }
  if (!input.apiKey.trim()) return { ok: false, message: 'Enter the API key first.' }
  try {
    const models = await listModels({
      provider: input.provider,
      apiKey: input.apiKey.trim(),
      ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
    })
    return { ok: true, models }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Model discovery for an already-saved provider (key unsealed server-side only). */
export async function loadModelsForProviderAction(
  slug: string,
): Promise<{ ok: true; models: { id: string; label?: string }[] } | { ok: false; message: string }> {
  const tenantId = await resolveTenantId()
  const providers = await listAiProviders(tenantId)
  const entry = providers.find((candidate) => candidate.slug === slug)
  if (!entry) return { ok: false, message: `No provider "${slug}".` }
  if (!isAiProvider(entry.provider)) return { ok: false, message: `Provider kind ${entry.provider} is invalid.` }
  const apiKey = unsealSecret(entry.sealedApiKey)
  if (apiKey === null) return { ok: false, message: 'Stored key cannot be unsealed.' }
  try {
    const models = await listModels({
      provider: entry.provider,
      apiKey,
      ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
    })
    return { ok: true, models }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Pull current prices from the OpenRouter catalog for models in use. */
export async function refreshPricesAction(): Promise<void> {
  const tenantId = await resolveTenantId()
  const { updated, unmatched } = await refreshPricesFromOpenRouter(tenantId)
  if (updated.length === 0 && unmatched.length > 0) {
    throw new Error(`No prices matched for: ${unmatched.join(', ')}. Add them manually.`)
  }
  revalidatePath('/admin/settings')
}

/** Append a manual effective-dated price row ('*' = company default). */
export async function setManualPriceAction(formData: FormData): Promise<void> {
  const model = String(formData.get('model') ?? '').trim()
  const inputUsd = Number(formData.get('inputUsdPerMtok'))
  const outputUsd = Number(formData.get('outputUsdPerMtok'))
  if (!Number.isFinite(inputUsd) || !Number.isFinite(outputUsd) || inputUsd < 0 || outputUsd < 0) {
    throw new Error('Prices must be non-negative USD per million tokens.')
  }
  const tenantId = await resolveTenantId()
  await setManualPrice({ tenantId, model, inputUsdPerMtok: inputUsd, outputUsdPerMtok: outputUsd })
  revalidatePath('/admin/settings')
}

/** Point avatar generation at one of the tenant's AI providers + image model. */
export async function setImageProviderAction(formData: FormData): Promise<void> {
  const providerSlug = String(formData.get('imageProviderSlug') ?? '')
  const model = String(formData.get('imageModel') ?? '') as ImageModelId
  if (!providerSlug || !model) throw new Error('Pick a provider and an image model.')
  const tenantId = await resolveTenantId()
  await setImageProviderSetting({ tenantId, providerSlug, model })
  revalidatePath('/admin/settings')
}
