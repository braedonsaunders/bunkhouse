'use server'

import { revalidatePath } from 'next/cache'
import { isAiProvider, listModels } from '@appkit/ai'
import { isSmsProvider } from '@appkit/sms/providers'
import { unsealSecret } from '@appkit/crypto'
import { addAiProvider, listAiProviders, removeAiProvider, resolveProviderAiConfig } from '../../../lib/ai'
import { listTenantElevenLabsVoices, removeSpeechProvider, setSpeechProviderKey, type SpeechProvider } from '../../../lib/voice'
import { resolveTenantId } from '../../../lib/tenant'
import { refreshPricesFromOpenRouter, setManualPrice } from '../../../lib/pricing'
import { setImageProviderSetting } from '../../../lib/avatars'
import { removeSearchProvider, setSearchProvider } from '../../../lib/research'
import { saveDocumentBranding } from '../../../lib/documents'
import { removeSmsSettings, saveSmsSettings } from '../../../lib/sms'
import { saveWorkspacePolicy } from '../../../lib/workspace'
import { listMcpIntegrations, saveMcpIntegrations } from '../../../lib/mcp-integrations'
import { isMailOauthProvider, removeMailOauthApp, saveMailOauthApp } from '../../../lib/mail-oauth'
import { beginMcpOauth } from '../../../lib/mcp-oauth'
import { connectMcpServers } from '@bunkhouse/runtime'
import { sealSecret } from '@appkit/crypto'
import { db } from '../../../db/client'
import { listImageModels, type ImageModelId } from '@appkit/avatars'

/** Add a model provider. Returns the failure rather than throwing: a thrown
 *  server-action error reaches the browser as an opaque digest in production,
 *  which tells an operator nothing about which model or key was refused. */
export async function addProviderAction(
  formData: FormData,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const slug = String(formData.get('slug') ?? '').trim().toLowerCase()
  const provider = String(formData.get('provider') ?? '')
  const label = String(formData.get('label') ?? '').trim() || slug
  const apiKey = String(formData.get('apiKey') ?? '').trim()
  const baseUrl = String(formData.get('baseUrl') ?? '').trim()
  const modelSmart = String(formData.get('modelSmart') ?? '').trim()
  const modelFast = String(formData.get('modelFast') ?? '').trim()
  if (!slug || !provider || !apiKey) {
    return { ok: false, message: 'Slug, provider kind, and API key are required.' }
  }

  try {
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
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  revalidatePath('/admin/settings')
  return { ok: true }
}

export async function removeProviderAction(formData: FormData): Promise<void> {
  const slug = String(formData.get('slug') ?? '')
  if (!slug) throw new Error('slug is required')
  const tenantId = await resolveTenantId()
  await removeAiProvider(tenantId, slug)
  revalidatePath('/admin/settings')
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

/** The action categories the autonomy dial governs — an integration runs
 *  entirely under the one chosen for it. */
const ACTION_CATEGORIES = [
  'external_email',
  'internal_email',
  'record_write',
  'money_adjacent',
  'file_write',
  'computer_use',
  'shell',
  'phone_call',
]

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
  if (!ACTION_CATEGORIES.includes(input.category)) {
    return { ok: false, message: 'Pick the action category it is governed under.' }
  }

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
    const all = await listMcpIntegrations(tenantId)
    const previous = all.find((entry) => entry.slug === slug)
    const entries = all.filter((entry) => entry.slug !== slug)
    // Blank headers on an edit mean "keep what is sealed", not "drop it".
    const sealedHeaders =
      Object.keys(headers).length > 0 ? sealSecret(JSON.stringify(headers)) : previous?.sealedHeaders
    entries.push({
      slug,
      label: input.label.trim(),
      url: url.toString(),
      ...(sealedHeaders ? { sealedHeaders } : {}),
      category: input.category,
    })
    await saveMcpIntegrations(tenantId, entries)
  })
  revalidatePath('/admin/settings')
  return { ok: true, toolCount }
}

/**
 * Start an OAuth sign-in for a connection. Returns the provider's consent URL
 * for the browser to follow; the connection is only saved once the provider
 * redirects back and the grant is proved against the server.
 */
export async function beginMcpOauthAction(input: {
  slug: string
  label: string
  url: string
  category: string
  /** Only for servers that do not offer automatic client registration. */
  clientId?: string
  clientSecret?: string
}): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const slug = input.slug.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  if (!slug) return { ok: false, message: 'Give the integration a short slug.' }
  if (!input.label.trim()) return { ok: false, message: 'Give the integration a name.' }
  let url: URL
  try {
    url = new URL(input.url.trim())
  } catch {
    return { ok: false, message: 'That URL is not valid.' }
  }
  if (url.protocol !== 'https:') {
    return { ok: false, message: 'OAuth sign-in requires an https server URL.' }
  }
  if (!ACTION_CATEGORIES.includes(input.category)) {
    return { ok: false, message: 'Pick the action category it is governed under.' }
  }
  try {
    const tenantId = await resolveTenantId()
    const { url: consentUrl } = await beginMcpOauth({
      tenantId,
      slug,
      label: input.label.trim(),
      url: url.toString(),
      category: input.category,
      ...(input.clientId?.trim() ? { clientId: input.clientId.trim() } : {}),
      ...(input.clientSecret?.trim() ? { clientSecret: input.clientSecret.trim() } : {}),
    })
    return { ok: true, url: consentUrl }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
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

export async function saveDocumentBrandingAction(input: {
  companyName: string
  accentColor: string
  footerText: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const accent = input.accentColor.trim()
  if (accent && !/^#[0-9a-fA-F]{6}$/.test(accent)) {
    return { ok: false, message: 'Accent color must be a hex value like #1a4d8f.' }
  }
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await saveDocumentBranding(tenantId, {
      ...(input.companyName.trim() ? { companyName: input.companyName.trim() } : {}),
      ...(accent ? { accentColor: accent } : {}),
      ...(input.footerText.trim() ? { footerText: input.footerText.trim() } : {}),
    })
  })
  revalidatePath('/admin/settings')
  return { ok: true }
}

export async function saveWorkspacePolicyAction(input: {
  retentionEnabled: boolean
  retentionDays: number
}): Promise<{ ok: true } | { ok: false; message: string }> {
  if (input.retentionEnabled && (!Number.isInteger(input.retentionDays) || input.retentionDays < 7)) {
    return { ok: false, message: 'Retention must be a whole number of days, 7 or more.' }
  }
  const tenantId = await resolveTenantId()
  await saveWorkspacePolicy(tenantId, {
    retentionDays: input.retentionEnabled ? input.retentionDays : null,
  })
  revalidatePath('/admin/settings')
  return { ok: true }
}

// --- SMS ---------------------------------------------------------------

/** Connect (or replace) the tenant's SMS provider — validated, then the
 *  credential is sealed before it is ever persisted. */
export async function saveSmsSettingsAction(input: {
  provider: string
  fromNumber: string
  secret: string
  twilioAccountSid?: string
  vonageApiKey?: string
  plivoAuthId?: string
  telnyxMessagingProfileId?: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!isSmsProvider(input.provider)) {
    return { ok: false, message: `Unknown SMS provider: ${input.provider}` }
  }
  if (!input.fromNumber.trim()) return { ok: false, message: 'Enter a sender phone number or ID.' }
  if (!input.secret.trim()) return { ok: false, message: "Enter this provider's credential." }
  try {
    const tenantId = await resolveTenantId()
    await saveSmsSettings({
      tenantId,
      provider: input.provider,
      fromNumber: input.fromNumber.trim(),
      secret: input.secret.trim(),
      ...(input.twilioAccountSid?.trim() ? { twilioAccountSid: input.twilioAccountSid.trim() } : {}),
      ...(input.vonageApiKey?.trim() ? { vonageApiKey: input.vonageApiKey.trim() } : {}),
      ...(input.plivoAuthId?.trim() ? { plivoAuthId: input.plivoAuthId.trim() } : {}),
      ...(input.telnyxMessagingProfileId?.trim() ? { telnyxMessagingProfileId: input.telnyxMessagingProfileId.trim() } : {}),
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  revalidatePath('/admin/settings')
  return { ok: true }
}

/** Remove the tenant's SMS provider; agents cannot send texts until reconnected. */
export async function removeSmsSettingsAction(): Promise<void> {
  const tenantId = await resolveTenantId()
  await removeSmsSettings(tenantId)
  revalidatePath('/admin/settings')
}

// --- Email sign-in applications --------------------------------------------

/** Save the company's Google Workspace or Microsoft 365 application. The
 *  client secret is sealed before it is persisted and never rendered back. */
export async function saveMailOauthAppAction(input: {
  provider: string
  clientId: string
  clientSecret: string
  directory?: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!isMailOauthProvider(input.provider)) {
    return { ok: false, message: 'Choose Google Workspace or Microsoft 365.' }
  }
  try {
    const tenantId = await resolveTenantId()
    await saveMailOauthApp({
      tenantId,
      provider: input.provider,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      ...(input.directory?.trim() ? { directory: input.directory.trim() } : {}),
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  revalidatePath('/admin/settings')
  return { ok: true }
}

/** Remove an email sign-in application. Mailboxes connected through it stop
 *  refreshing and report the missing application on their next sync. */
export async function removeMailOauthAppAction(
  provider: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!isMailOauthProvider(provider)) return { ok: false, message: 'Unknown mail provider.' }
  try {
    const tenantId = await resolveTenantId()
    await removeMailOauthApp(tenantId, provider)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  revalidatePath('/admin/settings')
  return { ok: true }
}
