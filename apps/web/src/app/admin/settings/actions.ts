'use server'

import { revalidatePath } from 'next/cache'
import { isAiProvider, listModels } from '@braedonsaunders/appkit-ai'
import { isSmsProvider } from '@braedonsaunders/appkit-sms/providers'
import { unsealSecret } from '@braedonsaunders/appkit-crypto'
import { addAiProvider, listAiProviders, removeAiProvider, resolveProviderAiConfig, updateAiProvider } from '../../../lib/ai'
import { listTenantElevenLabsVoices, removeSpeechProvider, setSpeechProviderKey, type SpeechProvider } from '../../../lib/voice'
import { resolveTenantId as resolveTenant } from '../../../lib/tenant'
const resolveTenantId = () => resolveTenant('settings.manage')
import { refreshPricesFromOpenRouter, setManualPrice } from '../../../lib/pricing'
import {
  isReconcilableProvider,
  reconcileTenant,
  removeBillingKey,
  setBillingKey,
} from '../../../lib/cost-reconciliation'
import { setImageProviderSetting } from '../../../lib/avatars'
import { removeSearchProvider, setSearchProvider } from '../../../lib/research'
import { saveDocumentBranding } from '../../../lib/documents'
import { compileMailSignature, saveMailSignature } from '../../../lib/mail-signature'
import { removeSmsSettings, saveSmsSettings } from '../../../lib/sms'
import { eq } from 'drizzle-orm'
import { backgroundJobs } from '../../../db/schema'
import { saveWorkspacePolicy } from '../../../lib/workspace'
import { deskIdFor, execOnDesk, resolveShellExecutionPolicy, type ShellExecutionPolicy } from '../../../lib/desk'
import { resolveDeskPolicy, saveDeskFeatures, saveDeskPolicy, type DeskPolicy } from '../../../lib/desk-policy'
import { isMailOauthProvider, removeMailOauthApp, saveMailOauthApp } from '../../../lib/mail-oauth'
import { db } from '../../../db/client'
import { listImageModels, type ImageModelId } from '@braedonsaunders/appkit-avatars'
import { saveLocaleSettings } from '../../../lib/localization'
import { requireTenantPermission } from '../../../lib/tenant'
import type { AppLocale } from '../../../lib/product-locales'

export async function saveLocaleSettingsAction(input: {
  defaultLocale: AppLocale
  enabledLocales: AppLocale[]
}): Promise<
  | { ok: true; settings: { defaultLocale: AppLocale; enabledLocales: AppLocale[] } }
  | { ok: false; message: string }
> {
  try {
    const access = await requireTenantPermission('settings.manage')
    const settings = await saveLocaleSettings({
      tenantId: access.tenantId,
      actorId: access.user.id,
      defaultLocale: input.defaultLocale,
      enabledLocales: input.enabledLocales,
    })
    revalidatePath('/', 'layout')
    revalidatePath('/admin/settings')
    return { ok: true, settings }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

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

/** Change a saved provider's label, default models, or — on rotation — its key.
 *  The slug is fixed: agents reference it from their own record. */
export async function updateProviderAction(input: {
  slug: string
  label: string
  modelSmart?: string
  modelFast?: string
  apiKey?: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const slug = input.slug.trim()
  const label = input.label.trim()
  if (!slug) return { ok: false, message: 'Which provider is being changed?' }
  if (!label) return { ok: false, message: 'Give the provider a label.' }
  try {
    const tenantId = await resolveTenantId()
    await updateAiProvider({
      tenantId,
      slug,
      label,
      ...(input.modelSmart?.trim() ? { modelSmart: input.modelSmart.trim() } : {}),
      ...(input.modelFast?.trim() ? { modelFast: input.modelFast.trim() } : {}),
      ...(input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : {}),
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

/**
 * Pull current prices from the OpenRouter catalog for models in use. Both
 * halves of the answer matter to an operator: what moved, and what the catalog
 * has never heard of — the second list is exactly the set of models that will
 * keep costing $0 until somebody prices them by hand.
 */
export async function refreshPricesAction(): Promise<
  { ok: true; updated: string[]; unmatched: string[] } | { ok: false; message: string }
> {
  try {
    const tenantId = await resolveTenantId()
    const { updated, unmatched } = await refreshPricesFromOpenRouter(tenantId)
    revalidatePath('/admin/settings')
    return { ok: true, updated, unmatched }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

// --- Reconciliation (what the provider says it charged) ---------------------

/** Connect a provider's administration key — proved against its own cost
 *  report before it is sealed, so an agent key pasted here fails here rather
 *  than silently every night. */
export async function setBillingKeyAction(input: {
  provider: string
  adminKey: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!isReconcilableProvider(input.provider)) {
    return { ok: false, message: `${input.provider} does not publish a cost report.` }
  }
  if (!input.adminKey.trim()) return { ok: false, message: 'Enter the administration key first.' }
  try {
    const tenantId = await resolveTenantId()
    await setBillingKey({ tenantId, provider: input.provider, adminKey: input.adminKey.trim() })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  revalidatePath('/admin/settings')
  return { ok: true }
}

/** Disconnect an administration key. Spend for that provider stays as the
 *  price table estimated it, unchecked, until a key is connected again. */
export async function removeBillingKeyAction(provider: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!isReconcilableProvider(provider)) return { ok: false, message: 'Unknown provider.' }
  const tenantId = await resolveTenantId()
  await removeBillingKey(tenantId, provider)
  revalidatePath('/admin/settings')
  return { ok: true }
}

/** Pull the providers' cost reports now instead of waiting for tonight's pass. */
export async function reconcileNowAction(): Promise<
  { ok: true; recorded: number; driftUsd: number; notes: string[] } | { ok: false; message: string }
> {
  try {
    const tenantId = await resolveTenantId()
    const outcomes = await reconcileTenant(tenantId)
    if (outcomes.length === 0) {
      return { ok: false, message: 'No administration key is connected, so there is no invoice to read.' }
    }
    return {
      ok: true,
      recorded: outcomes.reduce((total, outcome) => total + outcome.recorded, 0),
      driftUsd: outcomes.reduce((total, outcome) => total + outcome.driftUsd, 0),
      notes: outcomes.flatMap((outcome) => (outcome.message ? [`${outcome.provider}: ${outcome.message}`] : [])),
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    revalidatePath('/admin/settings')
  }
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

/**
 * Persist the company signature. The designer hands over its raw snapshot; the
 * sanitize + inline + expand pipeline runs here, once, so the send path only
 * ever renders already-trusted markup.
 */
export async function saveMailSignatureAction(input: {
  enabled: boolean
  accentColor: string
  rawHtml: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const accent = input.accentColor.trim()
  if (accent && !/^#[0-9a-fA-F]{6}$/.test(accent)) {
    return { ok: false, message: 'Accent color must be a hex value like #F5A623.' }
  }
  const compiled = compileMailSignature(input.rawHtml)
  if (compiled.errors.length > 0) {
    return { ok: false, message: compiled.errors[0] ?? 'This signature could not be compiled.' }
  }
  if (input.enabled && !compiled.compiledHtml.trim()) {
    return { ok: false, message: 'Design a signature before turning it on.' }
  }
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await saveMailSignature(tenantId, {
      enabled: input.enabled,
      sourceHtml: compiled.sourceHtml,
      compiledHtml: compiled.compiledHtml,
      ...(accent ? { accentColor: accent } : {}),
    })
  })
  revalidatePath('/admin/settings')
  return { ok: true }
}

export async function saveWorkspacePolicyAction(input: {
  retentionEnabled: boolean
  retentionDays: number
  shell: ShellExecutionPolicy
}): Promise<{ ok: true } | { ok: false; message: string }> {
  if (input.retentionEnabled && (!Number.isInteger(input.retentionDays) || input.retentionDays < 7)) {
    return { ok: false, message: 'Retention must be a whole number of days, 7 or more.' }
  }
  let shell: ShellExecutionPolicy
  try {
    shell = resolveShellExecutionPolicy(input.shell)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  const tenantId = await resolveTenantId()
  await saveWorkspacePolicy(tenantId, {
    retentionDays: input.retentionEnabled ? input.retentionDays : null,
    shell,
  })
  revalidatePath('/admin/settings')
  return { ok: true }
}

// --- Features and the desk ---------------------------------------------

/**
 * The one authoritative feature switchboard (AGENTS.md): persists the tenant's
 * company.features row through the same settings upsert the desk policy uses.
 * The resolver forces the child off with its parent, so a stored row can never
 * leave desktop screens on with agent desks off — and switching a feature off
 * withholds the capability everywhere while preserving every record it wrote.
 */
export async function saveFeaturesAction(input: {
  desk: boolean
  desktop: boolean
  remoteComputers: boolean
}): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const tenantId = await resolveTenantId()
    await saveDeskFeatures(tenantId, { desk: input.desk === true, desktop: input.desktop === true, remoteComputers: input.remoteComputers === true })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  revalidatePath('/admin/settings')
  return { ok: true }
}

/** Save the tenant's desk policy — every number bounds-checked before it lands. */
export async function saveDeskPolicyAction(
  input: DeskPolicy,
): Promise<{ ok: true } | { ok: false; message: string }> {
  let policy: DeskPolicy
  try {
    policy = resolveDeskPolicy(input)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  const tenantId = await resolveTenantId()
  await saveDeskPolicy(tenantId, policy)
  revalidatePath('/admin/settings')
  return { ok: true }
}

/**
 * Stop a background job on an agent's desk. A running process nobody can see
 * is the failure mode the jobs table exists to prevent; this is the other
 * half — the operator's way to end one.
 *
 * Mechanics and their limitation: the desk-v1 protocol has no job-signal
 * endpoint (the guest agent understands `job-signal`, but neither the runner
 * nor DeskHandle exposes it), so the kill is an ordinary exec in the guest —
 * `pkill -TERM -f` on the job's recorded command line. That terminates every
 * process whose command line matches, which is the job and any identical
 * sibling; a job whose command is not unique on the machine can take a twin
 * down with it. A `pkill` that matches nothing means the process is already
 * gone — both outcomes leave the job not running, so the row is closed either
 * way. The runner's own job-exit event confirms the death on the ledger the
 * next time that desk's events are drained.
 */
export async function killDeskJobAction(
  jobRowId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!jobRowId) return { ok: false, message: 'Which job should be stopped?' }
  const tenantId = await resolveTenantId()
  const app = db()
  const [job] = await app.withTenantContext(tenantId, () =>
    app.db
      .select({
        id: backgroundJobs.id,
        personId: backgroundJobs.personId,
        command: backgroundJobs.command,
        status: backgroundJobs.status,
      })
      .from(backgroundJobs)
      .where(eq(backgroundJobs.id, jobRowId)),
  )
  if (!job) return { ok: false, message: 'That job is not on the record.' }
  if (job.status !== 'running') return { ok: false, message: 'This job has already ended.' }

  const outcome = await execOnDesk({
    deskId: deskIdFor(tenantId, job.personId),
    command: ['/usr/bin/pkill', '-TERM', '-f', '--', job.command],
    timeoutMs: 15_000,
    outputLimitKb: 16,
  })
  // pkill exits 0 when it signalled, 1 when nothing matched (already gone) —
  // either way the process is not running. Anything else is a real failure:
  // the desk unreachable, or pkill itself refusing.
  if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
    return {
      ok: false,
      message: `The job could not be stopped: ${outcome.output.trim() || outcome.status}`,
    }
  }
  await app.withTenant(tenantId, async () => {
    await app.db
      .update(backgroundJobs)
      .set({ status: 'killed', exitedAt: new Date(), updatedAt: new Date() })
      .where(eq(backgroundJobs.id, jobRowId))
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
