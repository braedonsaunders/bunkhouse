import 'server-only'
import { and, eq } from 'drizzle-orm'
import { sealSecret, unsealSecret } from '@braedonsaunders/appkit-crypto'
import {
  isValidSmsDestination,
  resolveSmsTransport,
  sendSmsVia,
  validateStoredSmsConfig,
  type RawSmsConfig,
  type SmsProvider,
} from '@braedonsaunders/appkit-sms'
import { tenantSettings, SMS_PROVIDER_KEY, type SmsProviderSettings } from '../db/schema'
import { db } from '../db/client'

/**
 * Tenant-scoped SMS delivery: an operator picks one of five providers
 * (Twilio, Vonage, MessageBird, Plivo, Telnyx) in Settings → Text messaging.
 * The provider's single credential is sealed at rest with @braedonsaunders/appkit-crypto,
 * using @braedonsaunders/appkit-sms's own ciphertext/nonce fields, and is only unsealed here,
 * at send time, to build a transport. sendSms is the one entry point every
 * caller (agent abilities, notifications, etc.) should go through — nothing
 * outside this file talks to a provider's HTTP API directly.
 */

async function readSmsSettings(tenantId: string): Promise<SmsProviderSettings> {
  const app = db()
  const [row] = await app.db
    .select({ value: tenantSettings.value })
    .from(tenantSettings)
    .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, SMS_PROVIDER_KEY)))
  return (row?.value as SmsProviderSettings | undefined) ?? {}
}

async function writeSmsSettings(tenantId: string, value: SmsProviderSettings): Promise<void> {
  const app = db()
  await app.db
    .insert(tenantSettings)
    .values({ tenantId, key: SMS_PROVIDER_KEY, value })
    .onConflictDoUpdate({
      target: [tenantSettings.tenantId, tenantSettings.key],
      set: { value, updatedAt: new Date() },
    })
}

export type SmsSettingsView = {
  provider: SmsProvider | null
  fromNumber: string | null
}

/** Sealed state for the settings page — never the plaintext secret. */
export async function getSmsSettings(tenantId: string): Promise<SmsSettingsView> {
  const app = db()
  const settings = await app.withTenantContext(tenantId, () => readSmsSettings(tenantId))
  if (settings.enabled !== true || !settings.provider) return { provider: null, fromNumber: null }
  return { provider: settings.provider, fromNumber: settings.fromNumber ?? null }
}

export type SaveSmsSettingsInput = {
  tenantId: string
  provider: SmsProvider
  fromNumber: string
  /** Plaintext credential — sealed before it ever reaches storage. */
  secret: string
  twilioAccountSid?: string
  vonageApiKey?: string
  plivoAuthId?: string
  telnyxMessagingProfileId?: string
}

/** Validate the full config, seal the secret, and persist it. Throws with a
 *  clear message (from @braedonsaunders/appkit-sms's validateStoredSmsConfig) on failure. */
export async function saveSmsSettings(input: SaveSmsSettingsInput): Promise<void> {
  const sealed = sealSecret(input.secret)
  const candidate: RawSmsConfig = {
    enabled: true,
    provider: input.provider,
    fromNumber: input.fromNumber,
    ...(input.twilioAccountSid ? { twilioAccountSid: input.twilioAccountSid } : {}),
    ...(input.vonageApiKey ? { vonageApiKey: input.vonageApiKey } : {}),
    ...(input.plivoAuthId ? { plivoAuthId: input.plivoAuthId } : {}),
    ...(input.telnyxMessagingProfileId ? { telnyxMessagingProfileId: input.telnyxMessagingProfileId } : {}),
    keyCiphertext: sealed.ciphertext,
    keyNonce: sealed.nonce,
  }
  validateStoredSmsConfig(candidate, { requireComplete: true })
  const app = db()
  await app.withTenant(input.tenantId, () => writeSmsSettings(input.tenantId, candidate))
}

export async function removeSmsSettings(tenantId: string): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, () => writeSmsSettings(tenantId, {}))
}

/** Whether a complete, sendable SMS config is on file for this tenant. */
export async function smsConfigured(tenantId: string): Promise<boolean> {
  const app = db()
  const settings = await app.withTenantContext(tenantId, () => readSmsSettings(tenantId))
  if (settings.enabled !== true) return false
  try {
    validateStoredSmsConfig(settings, { requireComplete: true })
    return true
  } catch {
    return false
  }
}

/** Send an SMS on the tenant's configured provider. The one entry point for
 *  outbound text messages — resolves config, unseals the secret, builds the
 *  transport, and sends. Throws a clear message when unconfigured or invalid. */
export async function sendSms(args: { tenantId: string; to: string; body: string }): Promise<{ sent: true }> {
  const app = db()
  const settings = await app.withTenantContext(args.tenantId, () => readSmsSettings(args.tenantId))
  const transport = resolveSmsTransport(settings, unsealSecret)
  if (!transport) {
    throw new Error('SMS is not configured for this tenant. Add a provider in Settings → Text messaging.')
  }
  if (!isValidSmsDestination(args.to)) {
    throw new Error(`"${args.to}" is not a valid SMS destination — use E.164 format, e.g. +15551234567.`)
  }
  await sendSmsVia(transport, { to: args.to, body: args.body })
  return { sent: true }
}
