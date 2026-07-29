import 'server-only'
import { and, eq } from 'drizzle-orm'
import {
  tenantSettings,
  tokenSpend,
  VOICE_PRICING_KEY,
  type BunkhouseVoiceConfig,
  type MeasuredVoiceRate,
  type VoicePricingSettings,
} from '../db/schema'
import { db } from '../db/client'
import { measureDeepgramRate } from './deepgram-billing'
import { resolveSpeechCredential } from './voice'

/**
 * What speech costs. Model tokens are priced per million; hearing and speaking
 * are priced per minute of call. Both land in the same spend ledger, so an
 * agent's salary reflects everything it actually spent rather than only the
 * part that happens to be counted in tokens.
 *
 * Where a rate comes from is part of the record. Deepgram will say what it
 * charged, so its rate is measured from the company's own invoices and kept
 * current on its own. ElevenLabs meters in credits whose dollar value depends
 * on the plan, and realtime speech is billed as model tokens — neither can be
 * read from an API, so both stay operator-entered.
 *
 * Prices are never guessed. An unset rate means the minutes are still recorded
 * — on the call, in the run summary, against the agent's call budget — and no
 * money is claimed for them.
 */

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

/** Keep only well-formed, positive entries — a stored zero is not a price. */
function cleanMeasured(value: VoicePricingSettings['measured']): VoicePricingSettings['measured'] {
  const deepgram = value?.deepgram
  if (!deepgram || positive(deepgram.usdPerMinute) === undefined) return undefined
  return { deepgram }
}

function cleanPricing(value: VoicePricingSettings): VoicePricingSettings {
  const measured = cleanMeasured(value.measured)
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
    ...(measured ? { measured } : {}),
  }
}

async function readVoicePricing(tenantId: string): Promise<VoicePricingSettings> {
  const app = db()
  const [row] = await app.db
    .select({ value: tenantSettings.value })
    .from(tenantSettings)
    .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, VOICE_PRICING_KEY)))
  return cleanPricing((row?.value as VoicePricingSettings | undefined) ?? {})
}

export async function getVoicePricing(tenantId: string): Promise<VoicePricingSettings> {
  const app = db()
  return app.withTenantContext(tenantId, () => readVoicePricing(tenantId))
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
  const app = db()
  await app.withTenant(tenantId, async () => {
    // A measurement is not part of what the operator submits; carry the stored
    // one across so saving a typed rate never discards it.
    const current = await readVoicePricing(tenantId)
    const stored = cleanPricing({ ...value, ...(current.measured ? { measured: current.measured } : {}) })
    await app.db
      .insert(tenantSettings)
      .values({ tenantId, key: VOICE_PRICING_KEY, value: stored })
      .onConflictDoUpdate({
        target: [tenantSettings.tenantId, tenantSettings.key],
        set: { value: stored, updatedAt: new Date() },
      })
  })
}

/**
 * Read the company's real Deepgram rate off its own invoices and store it
 * beside the operator's figure. Returns what it found — including why it found
 * nothing — so the settings screen can say so plainly rather than sit silent.
 */
export async function refreshMeasuredVoiceRates(
  tenantId: string,
): Promise<{ ok: true; deepgram: MeasuredVoiceRate } | { ok: false; message: string }> {
  const apiKey = await resolveSpeechCredential(tenantId, 'deepgram')
  if (apiKey === null) {
    return { ok: false, message: 'No Deepgram key is connected, so there is no bill to read.' }
  }
  const measurement = await measureDeepgramRate(apiKey)
  if (!measurement.ok) return measurement

  const rate: MeasuredVoiceRate = {
    usdPerMinute: measurement.usdPerMinute,
    window: measurement.window,
    observedAt: new Date().toISOString(),
  }
  const app = db()
  await app.withTenant(tenantId, async () => {
    const current = await readVoicePricing(tenantId)
    const stored = cleanPricing({ ...current, measured: { deepgram: rate } })
    await app.db
      .insert(tenantSettings)
      .values({ tenantId, key: VOICE_PRICING_KEY, value: stored })
      .onConflictDoUpdate({
        target: [tenantSettings.tenantId, tenantSettings.key],
        set: { value: stored, updatedAt: new Date() },
      })
  })
  return { ok: true, deepgram: rate }
}

/** A per-minute rate, and where the number came from. */
export type EffectiveVoiceRate = { usdPerMinute: number; source: 'manual' | 'measured' }

/**
 * The rate in force for each speech leg. The operator's figure outranks the
 * measurement: somebody who typed a number knows a contract the invoices have
 * not caught up with yet.
 */
export function effectiveVoiceRates(pricing: VoicePricingSettings): {
  deepgram?: EffectiveVoiceRate
  elevenlabs?: EffectiveVoiceRate
  realtime?: EffectiveVoiceRate
} {
  const measuredDeepgram = positive(pricing.measured?.deepgram?.usdPerMinute)
  const deepgram =
    positive(pricing.deepgramUsdPerMinute) !== undefined
      ? ({ usdPerMinute: pricing.deepgramUsdPerMinute!, source: 'manual' } as const)
      : measuredDeepgram !== undefined
        ? ({ usdPerMinute: measuredDeepgram, source: 'measured' } as const)
        : undefined
  return {
    ...(deepgram ? { deepgram } : {}),
    ...(positive(pricing.elevenLabsUsdPerMinute) !== undefined
      ? { elevenlabs: { usdPerMinute: pricing.elevenLabsUsdPerMinute!, source: 'manual' as const } }
      : {}),
    ...(positive(pricing.realtimeUsdPerMinute) !== undefined
      ? { realtime: { usdPerMinute: pricing.realtimeUsdPerMinute!, source: 'manual' as const } }
      : {}),
  }
}

/** One priced leg of a call's speech: who provided it, and what it cost. */
export type SpeechCostLine = {
  provider: string
  model: string
  usdPerMinute: number
  usd: number
  /** Whether the rate was typed in or read off the provider's own bill. */
  rateSource: 'manual' | 'measured'
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
  const rates = effectiveVoiceRates(args.pricing)
  const lines: SpeechCostLine[] = []
  const add = (provider: string, model: string, rate: EffectiveVoiceRate | undefined) => {
    if (!rate || rate.usdPerMinute <= 0) return
    lines.push({
      provider,
      model,
      usdPerMinute: rate.usdPerMinute,
      usd: rate.usdPerMinute * minutes,
      rateSource: rate.source,
    })
  }
  if (args.config.mode === 'cascade') {
    add('deepgram', args.config.cascade?.sttModel ?? 'deepgram', rates.deepgram)
    add('elevenlabs', args.config.cascade?.ttsModel ?? 'elevenlabs', rates.elevenlabs)
  } else {
    add(args.config.realtime?.provider ?? 'realtime', args.config.realtime?.model ?? 'realtime', rates.realtime)
  }
  return lines
}

/**
 * Meter a finished call's speech minutes into the spend ledger, next to the
 * model tokens the same call burned, and return what it came to. Rows carry
 * zero tokens and the per-minute price that was in force, so the ledger stays
 * readable: this money bought minutes, not tokens, and the flag says whether
 * the rate was typed in or measured.
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
        priceSource: line.rateSource === 'measured' ? 'voice_minutes_measured' : 'voice_minutes',
      })
    }
  })
  return { usd: lines.reduce((total, line) => total + line.usd, 0), lines }
}
