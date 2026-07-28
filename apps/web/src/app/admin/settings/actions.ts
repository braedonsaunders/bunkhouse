'use server'

import { revalidatePath } from 'next/cache'
import { isAiProvider, listModels } from '@appkit/ai'
import { unsealSecret } from '@appkit/crypto'
import { addAiProvider, listAiProviders, removeAiProvider, resolveProviderAiConfig } from '../../../lib/ai'
import { listTenantElevenLabsVoices, removeSpeechProvider, setSpeechProviderKey, type SpeechProvider } from '../../../lib/voice'
import { resolveTenantId } from '../../../lib/tenant'
import { refreshPricesFromOpenRouter, setManualPrice } from '../../../lib/pricing'
import { setImageProviderSetting } from '../../../lib/avatars'
import { removeSearchProvider, setSearchProvider } from '../../../lib/research'
import { listMcpIntegrations, saveMcpIntegrations } from '../../../lib/agent-abilities'
import { connectMcpServers } from '@bunkhouse/runtime'
import { sealSecret } from '@appkit/crypto'
import { db } from '../../../db/client'
import { listImageModels, type ImageModelId } from '@appkit/avatars'

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

/** Save a speech-provider key (cascade voice) — live-verified before sealing. */
export async function setSpeechProviderKeyAction(input: {
  provider: string
  apiKey: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  if (input.provider !== 'deepgram' && input.provider !== 'elevenlabs') {
    return { ok: false, message: `Unknown speech provider: ${input.provider}` }
  }
  if (!input.apiKey.trim()) return { ok: false, message: 'Enter the API key first.' }
  try {
    const tenantId = await resolveTenantId()
    await setSpeechProviderKey({ tenantId, provider: input.provider, apiKey: input.apiKey.trim() })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  revalidatePath('/admin/settings')
  return { ok: true }
}

/** Remove a speech-provider key. Agents configured to use it stop being callable. */
export async function removeSpeechProviderAction(formData: FormData): Promise<void> {
  const provider = String(formData.get('provider') ?? '') as SpeechProvider
  if (provider !== 'deepgram' && provider !== 'elevenlabs') throw new Error('Unknown speech provider.')
  const tenantId = await resolveTenantId()
  await removeSpeechProvider(tenantId, provider)
  revalidatePath('/admin/settings')
}

/** Live ElevenLabs voice catalog for the voice picker (key stays sealed here). */
export async function listVoicesForTenantAction(): Promise<
  { ok: true; voices: { id: string; name: string; hint?: string }[] } | { ok: false; message: string }
> {
  const tenantId = await resolveTenantId()
  return listTenantElevenLabsVoices(tenantId)
}

/**
 * Live image-model discovery for a saved provider (key stays sealed here).
 * The provider's model API is authoritative — the static catalog is only a
 * fallback the client may offer when this fails.
 */
export async function listImageModelsForProviderAction(
  providerSlug: string,
): Promise<{ ok: true; models: { id: string; name?: string }[] } | { ok: false; message: string }> {
  const tenantId = await resolveTenantId()
  const config = await resolveProviderAiConfig(tenantId, providerSlug)
  if (!config) {
    return { ok: false, message: `The "${providerSlug}" provider is missing or its key cannot be unsealed.` }
  }
  try {
    const models = await listImageModels(config)
    if (models.length === 0) {
      return { ok: false, message: 'The provider returned no image-capable models for this key.' }
    }
    return { ok: true, models }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
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

// --- Research (web search) --------------------------------------------------

/** Save the web-search provider key — live-verified before sealing. */
export async function setSearchProviderAction(input: {
  provider: string
  apiKey: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  if (input.provider !== 'brave' && input.provider !== 'tavily') {
    return { ok: false, message: `Unknown search provider: ${input.provider}` }
  }
  if (!input.apiKey.trim()) return { ok: false, message: 'Enter the API key first.' }
  try {
    const tenantId = await resolveTenantId()
    await setSearchProvider({ tenantId, provider: input.provider, apiKey: input.apiKey.trim() })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  revalidatePath('/admin/settings')
  return { ok: true }
}

/** Remove the search provider; agents fall back to keyless search. */
export async function removeSearchProviderAction(): Promise<void> {
  const tenantId = await resolveTenantId()
  await removeSearchProvider(tenantId)
  revalidatePath('/admin/settings')
}

// --- Integrations (MCP) -----------------------------------------------------

/** Add or replace an MCP integration; the connection is probed before saving. */
export async function saveMcpIntegrationAction(input: {
  slug: string
  label: string
  url: string
  /** One header per line, `Name: value`. Sealed at rest, never echoed back. */
  headersText: string
  category: string
}): Promise<{ ok: true; toolCount: number } | { ok: false; message: string }> {
  const slug = input.slug.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  if (!slug) return { ok: false, message: 'Give the integration a short slug.' }
  if (!input.label.trim()) return { ok: false, message: 'Give the integration a name.' }
  let url: URL
  try {
    url = new URL(input.url.trim())
  } catch {
    return { ok: false, message: 'That URL is not valid.' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: 'The server URL must be http(s).' }
  }
  const categories = [
    'external_email',
    'internal_email',
    'record_write',
    'money_adjacent',
    'file_write',
    'computer_use',
    'shell',
    'phone_call',
  ]
  if (!categories.includes(input.category)) return { ok: false, message: 'Pick the action category it is governed under.' }

  const headers: Record<string, string> = {}
  for (const line of input.headersText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const colon = trimmed.indexOf(':')
    if (colon <= 0) return { ok: false, message: `Header line "${trimmed.slice(0, 40)}" is not "Name: value".` }
    headers[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim()
  }

  // Probe the connection so a typo'd URL or bad token fails here, not mid-call.
  let toolCount = 0
  try {
    const probe = await connectMcpServers([
      {
        slug,
        url: url.toString(),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
    ])
    toolCount = probe.abilities.length
    await probe.close()
  } catch (error) {
    return {
      ok: false,
      message: `Could not connect: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    const entries = (await listMcpIntegrations(tenantId)).filter((entry) => entry.slug !== slug)
    entries.push({
      slug,
      label: input.label.trim(),
      url: url.toString(),
      ...(Object.keys(headers).length > 0 ? { sealedHeaders: sealSecret(JSON.stringify(headers)) } : {}),
      category: input.category,
    })
    await saveMcpIntegrations(tenantId, entries)
  })
  revalidatePath('/admin/settings')
  return { ok: true, toolCount }
}

export async function removeMcpIntegrationAction(formData: FormData): Promise<void> {
  const slug = String(formData.get('slug') ?? '')
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    const entries = (await listMcpIntegrations(tenantId)).filter((entry) => entry.slug !== slug)
    await saveMcpIntegrations(tenantId, entries)
  })
  revalidatePath('/admin/settings')
}
