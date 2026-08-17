import 'server-only'
import { and, eq } from 'drizzle-orm'
import { sealSecret, unsealSecret } from '@braedonsaunders/appkit-crypto'
import {
  listElevenLabsVoices,
  verifyDeepgramKey,
  verifyElevenLabsKey,
  type SttProvider,
  type TtsProvider,
  type VoiceCatalogItem,
} from '@braedonsaunders/appkit-voice'
import { tenantSettings, VOICE_PROVIDERS_KEY, type VoiceProviderSettings } from '../db/schema'
import { db } from '../db/client'
import { listAiProviders, resolveProviderAiConfig } from './ai'

/**
 * Tenant speech-provider credentials for cascade voice (Deepgram STT,
 * ElevenLabs TTS). Keys are live-verified before sealing and unsealed only
 * at use time — the same doctrine as AI providers. Realtime voice reuses
 * the tenant's AI provider keys (OpenAI/Google); nothing is duplicated.
 */
export type SpeechProvider = SttProvider | TtsProvider

async function readVoiceProviders(tenantId: string): Promise<VoiceProviderSettings> {
  const app = db()
  const [row] = await app.db
    .select({ value: tenantSettings.value })
    .from(tenantSettings)
    .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, VOICE_PROVIDERS_KEY)))
  return (row?.value as VoiceProviderSettings | undefined) ?? {}
}

async function writeVoiceProviders(tenantId: string, value: VoiceProviderSettings): Promise<void> {
  const app = db()
  await app.db
    .insert(tenantSettings)
    .values({ tenantId, key: VOICE_PROVIDERS_KEY, value })
    .onConflictDoUpdate({
      target: [tenantSettings.tenantId, tenantSettings.key],
      set: { value, updatedAt: new Date() },
    })
}

/** Sealed provider entries — safe to agent to the settings page. */
export async function getVoiceProviders(tenantId: string): Promise<VoiceProviderSettings> {
  const app = db()
  return app.withTenantContext(tenantId, () => readVoiceProviders(tenantId))
}

/** Verify the key against the provider's live API, then seal and store it. */
export async function setSpeechProviderKey(args: {
  tenantId: string
  provider: SpeechProvider
  apiKey: string
}): Promise<void> {
  const verify = args.provider === 'deepgram' ? await verifyDeepgramKey(args.apiKey) : await verifyElevenLabsKey(args.apiKey)
  if (!verify.ok) throw new Error(verify.message)
  const app = db()
  await app.withTenant(args.tenantId, async () => {
    const current = await readVoiceProviders(args.tenantId)
    await writeVoiceProviders(args.tenantId, {
      ...current,
      [args.provider]: { sealedApiKey: sealSecret(args.apiKey) },
    })
  })
}

export async function removeSpeechProvider(tenantId: string, provider: SpeechProvider): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    const current = await readVoiceProviders(tenantId)
    const next = { ...current }
    delete next[provider]
    await writeVoiceProviders(tenantId, next)
  })
}

/** Unseal a speech-provider key at use time; null when not configured. */
export async function resolveSpeechCredential(tenantId: string, provider: SpeechProvider): Promise<string | null> {
  const providers = await getVoiceProviders(tenantId)
  const entry = providers[provider]
  if (!entry) return null
  return unsealSecret(entry.sealedApiKey)
}

/**
 * Realtime speech-to-speech runs on the tenant's own AI provider keys.
 * Finds the first configured AI provider of the requested kind and resolves
 * its live config (key unsealed at use time).
 */
export async function resolveRealtimeCredential(
  tenantId: string,
  kind: 'openai' | 'google',
): Promise<{ slug: string; apiKey: string; baseUrl: string | null } | null> {
  const providers = await listAiProviders(tenantId)
  const entry = providers.find((p) => p.provider === kind)
  if (!entry) return null
  const config = await resolveProviderAiConfig(tenantId, entry.slug)
  if (!config) return null
  return { slug: entry.slug, apiKey: config.apiKey, baseUrl: config.baseUrl ?? null }
}

/** AI providers an agent's realtime voice can run on (openai/google kinds). */
export async function listRealtimeCapableProviders(
  tenantId: string,
): Promise<{ slug: string; label: string; kind: 'openai' | 'google' }[]> {
  const providers = await listAiProviders(tenantId)
  return providers
    .filter((p): p is typeof p & { provider: 'openai' | 'google' } => p.provider === 'openai' || p.provider === 'google')
    .map((p) => ({ slug: p.slug, label: p.label, kind: p.provider }))
}

/** Live TTS voice catalog from the tenant's own ElevenLabs account. */
export async function listTenantElevenLabsVoices(
  tenantId: string,
): Promise<{ ok: true; voices: VoiceCatalogItem[] } | { ok: false; message: string }> {
  const apiKey = await resolveSpeechCredential(tenantId, 'elevenlabs')
  if (apiKey === null) {
    return { ok: false, message: 'No ElevenLabs key is configured. Add one in Settings → Voice.' }
  }
  try {
    return { ok: true, voices: await listElevenLabsVoices(apiKey) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
