'use server'

import { revalidatePath } from 'next/cache'
import { resolveTenantId } from '../../../lib/tenant'
import { saveVoiceRetention, sweepExpiredRecordings } from '../../../lib/voice-recording'
import { refreshMeasuredVoiceRates, saveVoicePricing } from '../../../lib/voice-pricing'

/**
 * Company settings for what calls cost and how long they are kept. Both are
 * plain tenant configuration: the recording window is a policy the company
 * owns, and the per-minute prices come from its own contracts with its speech
 * providers — bunkhouse never supplies a price of its own.
 *
 * The settings page reads the current values server-side with
 * `getVoiceRetention` / `getVoicePricing`; these are the writes.
 */

/** A price field as it arrives from the form: blank means "not priced". */
function parsePrice(raw: string, label: string): number | undefined {
  const text = raw.trim()
  if (!text) return undefined
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a number of dollars per minute, or blank.`)
  }
  return value
}

export async function saveVoiceRetentionAction(input: {
  retentionEnabled: boolean
  recordingDays: number
}): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const tenantId = await resolveTenantId()
    await saveVoiceRetention(tenantId, {
      recordingDays: input.retentionEnabled ? input.recordingDays : null,
    })
    revalidatePath('/admin/settings')
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export async function saveVoicePricingAction(input: {
  deepgramUsdPerMinute: string
  elevenLabsUsdPerMinute: string
  realtimeUsdPerMinute: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const deepgram = parsePrice(input.deepgramUsdPerMinute, 'The Deepgram rate')
    const eleven = parsePrice(input.elevenLabsUsdPerMinute, 'The ElevenLabs rate')
    const realtime = parsePrice(input.realtimeUsdPerMinute, 'The speech-to-speech rate')
    const tenantId = await resolveTenantId()
    await saveVoicePricing(tenantId, {
      ...(deepgram !== undefined ? { deepgramUsdPerMinute: deepgram } : {}),
      ...(eleven !== undefined ? { elevenLabsUsdPerMinute: eleven } : {}),
      ...(realtime !== undefined ? { realtimeUsdPerMinute: realtime } : {}),
    })
    revalidatePath('/admin/settings')
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Read the company's real Deepgram rate off its own invoices. Deepgram is the
 * one speech provider that will say what it charged; the rate it reports is
 * used only where no rate has been entered by hand.
 */
export async function measureSpeechRatesAction(): Promise<
  { ok: true; usdPerMinute: number; window: string } | { ok: false; message: string }
> {
  try {
    const tenantId = await resolveTenantId()
    const result = await refreshMeasuredVoiceRates(tenantId)
    if (!result.ok) return result
    revalidatePath('/admin/settings')
    return { ok: true, usdPerMinute: result.deepgram.usdPerMinute, window: result.deepgram.window }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Apply the recording retention policy now, rather than waiting for the next
 * housekeeping pass — the operator's way of proving the policy does what they
 * just set it to do.
 */
export async function sweepRecordingsNowAction(): Promise<
  { ok: true; deleted: number } | { ok: false; message: string }
> {
  try {
    const tenantId = await resolveTenantId()
    const { deleted } = await sweepExpiredRecordings(tenantId)
    revalidatePath('/admin/settings')
    return { ok: true, deleted }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
