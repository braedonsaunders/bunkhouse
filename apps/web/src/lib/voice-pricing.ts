import 'server-only'
import { and, eq } from 'drizzle-orm'
import {
  tenantSettings,
  tokenSpend,
  VOICE_PRICING_KEY,
  type BunkhouseVoiceConfig,
  type VoicePricingSettings,
} from '../db/schema'
import { db } from '../db/client'

/**
 * What speech costs. Model tokens are priced per million; hearing and speaking
 * are priced per minute of call, from the company's own contracts with its
 * speech providers. Both land in the same spend ledger, so an agent's salary
 * reflects everything it actually spent rather than only the part that happens
 * to be counted in tokens.
 *
 * Prices are never guessed. An unset per-minute price means the minutes are
 * still recorded — on the call, in the run summary, against the agent's call
 * budget — and no money is claimed for them.
 */

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

export async function getVoicePricing(tenantId: string): Promise<VoicePricingSettings> {
  const app = db()
  const [row] = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ value: tenantSettings.value })
      .from(tenantSettings)
      .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, VOICE_PRICING_KEY))),
  )
  const value = (row?.value as VoicePricingSettings | undefined) ?? {}
  return {
    ...(positive(value.deepgramUsdPerMinute) !== undefined
      ? { deepgramUsdPerMinute: value.deepgramUsdPerMinute! }
      : {}),
    ...(positive(value.elevenLabsUsdPerMinute) !== undefined
      ? { elevenLabsUsdPerMinute: value.elevenLabsUsdPerMinute! }
      : {}),
    ...(positive(value.realtimeUsdPerMinute) !== undefined
      ? { realtimeUsdPerMinute: value.realtimeUsdPerMinute! }
      : {}),
  }
}

export async function saveVoicePricing(tenantId: string, value: VoicePricingSettings): Promise<void> {
  for (const [label, price] of [
    ['Deepgram', value.deepgramUsdPerMinute],
    ['ElevenLabs', value.elevenLabsUsdPerMinute],
    ['Speech-to-speech', value.realtimeUsdPerMinute],
  ] as const) {
    if (price === undefined) continue
    if (!Number.isFinite(price) || price < 0) throw new Error(`${label} price per minute must be zero or more.`)
  }
  const stored: VoicePricingSettings = {
    ...(positive(value.deepgramUsdPerMinute) !== undefined ? { deepgramUsdPerMinute: value.deepgramUsdPerMinute! } : {}),
    ...(positive(value.elevenLabsUsdPerMinute) !== undefined
      ? { elevenLabsUsdPerMinute: value.elevenLabsUsdPerMinute! }
      : {}),
    ...(positive(value.realtimeUsdPerMinute) !== undefined ? { realtimeUsdPerMinute: value.realtimeUsdPerMinute! } : {}),
  }
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .insert(tenantSettings)
      .values({ tenantId, key: VOICE_PRICING_KEY, value: stored })
      .onConflictDoUpdate({
        target: [tenantSettings.tenantId, tenantSettings.key],
        set: { value: stored, updatedAt: new Date() },
      })
  })
}

/** One priced leg of a call's speech: who provided it, and what it cost. */
export type SpeechCostLine = {
  provider: string
  model: string
  usdPerMinute: number
  usd: number
}

/**
 * The speech legs a call ran on, priced. Cascade calls pay for hearing and
 * speaking separately; a realtime call pays one speech-to-speech rate. Minutes
 * are exact (seconds ÷ 60) — providers meter by the second, and rounding a
 * 20-second call up to a full minute would overstate the company's spend.
 */
export function speechCostLines(args: {
  pricing: VoicePricingSettings
  config: BunkhouseVoiceConfig | null
  durationSeconds: number
}): SpeechCostLine[] {
  const minutes = Math.max(0, args.durationSeconds) / 60
  if (minutes === 0 || !args.config) return []
  const lines: SpeechCostLine[] = []
  const add = (provider: string, model: string, usdPerMinute: number | undefined) => {
    if (usdPerMinute === undefined || usdPerMinute <= 0) return
    lines.push({ provider, model, usdPerMinute, usd: usdPerMinute * minutes })
  }
  if (args.config.mode === 'cascade') {
    add('deepgram', args.config.cascade?.sttModel ?? 'deepgram', args.pricing.deepgramUsdPerMinute)
    add('elevenlabs', args.config.cascade?.ttsModel ?? 'elevenlabs', args.pricing.elevenLabsUsdPerMinute)
  } else {
    add(
      args.config.realtime?.provider ?? 'realtime',
      args.config.realtime?.model ?? 'realtime',
      args.pricing.realtimeUsdPerMinute,
    )
  }
  return lines
}

/**
 * Meter a finished call's speech minutes into the spend ledger, next to the
 * model tokens the same call burned, and return what it came to. Rows carry
 * zero tokens and the per-minute price that was in force, so the ledger stays
 * readable: this money bought minutes, not tokens.
 */
export async function meterSpeechMinutes(args: {
  tenantId: string
  personId: string
  runId: string
  config: BunkhouseVoiceConfig | null
  durationSeconds: number
}): Promise<{ usd: number; lines: SpeechCostLine[] }> {
  const pricing = await getVoicePricing(args.tenantId)
  const lines = speechCostLines({ pricing, config: args.config, durationSeconds: args.durationSeconds })
  if (lines.length === 0) return { usd: 0, lines }

  const app = db()
  await app.withTenant(args.tenantId, async () => {
    for (const line of lines) {
      await app.db.insert(tokenSpend).values({
        tenantId: args.tenantId,
        personId: args.personId,
        runId: args.runId,
        provider: line.provider,
        model: line.model,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: line.usd.toFixed(6),
        priceSource: 'voice_minutes',
      })
    }
  })
  return { usd: lines.reduce((total, line) => total + line.usd, 0), lines }
}
