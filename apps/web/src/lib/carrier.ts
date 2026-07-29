import 'server-only'
import { and, eq } from 'drizzle-orm'
import { sealSecret, unsealSecret } from '@appkit/crypto'
import {
  CarrierError,
  buildCarrierClient,
  resolveCarrierClient,
  type AvailableNumber,
  type CarrierClient,
} from '@appkit/telephony'
import { CARRIER_KEY, phoneNumbers, tenantSettings, type CarrierSettings } from '../db/schema'
import { db } from '../db/client'
import {
  assignPhoneNumber,
  createSipTrunk,
  listSipTrunks,
  normalizePhoneNumber,
  removePhoneNumber,
  sipIngressAddress,
  type SipTrunkRow,
} from './pbx'

/**
 * The company's carrier account, and getting a real phone number out of it.
 *
 * An operator connects a Twilio account once; from then on buying a number is
 * one action here. The first purchase also builds the line the numbers arrive
 * on — @appkit/telephony provisions the carrier side and hands back one
 * normalized trunk (where to send calls, how to authenticate, which addresses
 * calls arrive from), which is mirrored to a sip_trunks row like any other line
 * the company has. Nothing about that trunk is special afterwards: it shows on
 * the Trunks tab, it is health-checked, and calls over it are ordinary calls.
 *
 * Which carrier objects exist behind that is the package's business, not ours —
 * this file knows about phone numbers, agents, and SIP lines.
 *
 * Credentials are sealed at rest and unsealed only for a request to the
 * carrier, the same contract Settings → Text messaging keeps with its key.
 */

async function readSettings(tenantId: string): Promise<CarrierSettings> {
  const app = db()
  const [row] = await app.db
    .select({ value: tenantSettings.value })
    .from(tenantSettings)
    .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, CARRIER_KEY)))
  return (row?.value as CarrierSettings | undefined) ?? {}
}

async function writeSettings(tenantId: string, value: CarrierSettings): Promise<void> {
  const app = db()
  await app.db
    .insert(tenantSettings)
    .values({ tenantId, key: CARRIER_KEY, value })
    .onConflictDoUpdate({
      target: [tenantSettings.tenantId, tenantSettings.key],
      set: { value, updatedAt: new Date() },
    })
}

export type CarrierSettingsView = {
  /** The connected account's identifier, or null when none is connected. */
  accountId: string | null
}

/** Connected state for the settings page — never the token itself. */
export async function getCarrierSettings(tenantId: string): Promise<CarrierSettingsView> {
  const app = db()
  const settings = await app.withTenantContext(tenantId, () => readSettings(tenantId))
  return { accountId: settings.accountId ?? null }
}

/** Check the credentials against the carrier before storing them — a token that
 *  does not work is worse than none, because it fails at the moment someone
 *  is trying to buy a number. */
export async function saveTwilioCredentials(args: {
  tenantId: string
  accountSid: string
  authToken: string
}): Promise<{ ok: true; friendlyName: string } | { ok: false; message: string }> {
  const accountId = args.accountSid.trim()
  const secret = args.authToken.trim()
  let client: CarrierClient
  try {
    // The package validates the account identifier's shape as it builds.
    client = buildCarrierClient({ provider: 'twilio', accountId, secret })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  try {
    const account = await client.verifyAccount()
    const sealed = sealSecret(secret)
    const app = db()
    await app.withTenant(args.tenantId, () =>
      writeSettings(args.tenantId, {
        enabled: true,
        provider: 'twilio',
        accountId,
        keyCiphertext: sealed.ciphertext,
        keyNonce: sealed.nonce,
      }),
    )
    return { ok: true, friendlyName: account.accountLabel }
  } catch (error) {
    return { ok: false, message: describe(error, 'Twilio would not accept those credentials') }
  }
}

/** Disconnect the account. Numbers already bought keep working — they are on
 *  the carrier and on the trunk — but nothing more can be bought or released
 *  here until an account is connected again. */
export async function removeTwilioCredentials(tenantId: string): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, () => writeSettings(tenantId, {}))
}

/** The carrier client for this company, or null when none is connected. A
 *  secret that will not unseal resolves to null inside the package, which is
 *  the honest answer: an account nothing can authenticate as is no account. */
async function carrierClient(tenantId: string): Promise<CarrierClient | null> {
  const app = db()
  const settings = await app.withTenantContext(tenantId, () => readSettings(tenantId))
  return resolveCarrierClient(settings, unsealSecret)
}

/** The carrier's message when it has one, ours when it does not. */
function describe(error: unknown, prefix: string): string {
  if (error instanceof CarrierError) return `${prefix}: ${error.message}`
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`
}

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

export type NumberSearchResult =
  | { ok: true; numbers: AvailableNumber[] }
  | { ok: false; message: string }

export async function searchCarrierNumbers(args: {
  tenantId: string
  country: string
  areaCode?: string
  contains?: string
}): Promise<NumberSearchResult> {
  const client = await carrierClient(args.tenantId)
  if (!client) return { ok: false, message: 'Connect a Twilio account first.' }
  try {
    const numbers = await client.searchNumbers({
      country: args.country,
      ...(args.areaCode?.trim() ? { areaCode: args.areaCode.trim() } : {}),
      ...(args.contains?.trim() ? { contains: args.contains.trim() } : {}),
    })
    return { ok: true, numbers }
  } catch (error) {
    return { ok: false, message: describe(error, 'Twilio could not search for numbers') }
  }
}

// ---------------------------------------------------------------------------
// The carrier line
// ---------------------------------------------------------------------------

/** The tenant's carrier trunk row, if one has been provisioned. */
async function findCarrierTrunk(tenantId: string): Promise<SipTrunkRow | null> {
  const trunks = await listSipTrunks(tenantId)
  return trunks.find((trunk) => trunk.flavor === 'twilio_sip' && trunk.carrierTrunkSid) ?? null
}

/**
 * The line carrier numbers arrive on, built if it is not there yet.
 *
 * Order matters: the carrier side is provisioned first, and only a complete
 * trunk becomes a row here. The package unwinds its own partial failures, so a
 * rejected call leaves the carrier account as it was found; what it hands back
 * is either a working trunk or an error.
 */
async function ensureCarrierTrunk(
  tenantId: string,
  client: CarrierClient,
): Promise<{ ok: true; trunk: SipTrunkRow } | { ok: false; message: string }> {
  const existing = await findCarrierTrunk(tenantId)
  if (existing) return { ok: true, trunk: existing }

  const ingress = sipIngressAddress()
  if (!ingress) {
    return {
      ok: false,
      message: 'This deployment publishes no SIP address, so Twilio would have nowhere to send calls.',
    }
  }

  let provisioned
  try {
    provisioned = await client.ensureTrunk({
      label: 'bunkhouse',
      originationUri: `sip:${ingress.host}:${ingress.port}`,
    })
  } catch (error) {
    return { ok: false, message: describe(error, 'The Twilio trunk could not be created') }
  }

  try {
    const trunk = await createSipTrunk(tenantId, {
      name: 'Twilio',
      flavor: 'twilio_sip',
      mode: 'trunk',
      // Termination: where this deployment sends calls out.
      pbxHost: provisioned.terminationHost,
      pbxPort: provisioned.terminationPort,
      transport: 'udp',
      srtp: 'disabled',
      sessionTimerSeconds: null,
      // Origination: where calls come in from. Seeded from the carrier's
      // published ranges and editable afterwards, because carriers add edges.
      allowedAddresses: provisioned.signalingRanges,
      authUsername: provisioned.authUsername,
      authPassword: provisioned.authPassword,
      dialScope: 'external',
      carrierTrunkSid: provisioned.carrierTrunkId,
    })
    return { ok: true, trunk }
  } catch (error) {
    // Nothing points at the carrier trunk yet, so taking it back out leaves the
    // account as it was found. Cleanup failure is not worth reporting over the
    // failure that caused it.
    await client.deleteTrunk(provisioned.carrierTrunkId).catch(() => undefined)
    return { ok: false, message: describe(error, 'The carrier line could not be saved') }
  }
}

// ---------------------------------------------------------------------------
// Buying and releasing
// ---------------------------------------------------------------------------

export type BuyNumberResult =
  | { ok: true; number: string; trunkName: string }
  | { ok: false; message: string }

/**
 * Buy a number and put an agent on it. The number is bought onto the carrier
 * trunk, so it is answering before this returns — there is no window where it
 * rings and nothing picks up.
 */
export async function buyCarrierNumber(args: {
  tenantId: string
  number: string
  label: string
  personId: string
}): Promise<BuyNumberResult> {
  const client = await carrierClient(args.tenantId)
  if (!client) return { ok: false, message: 'Connect a Twilio account first.' }
  const digits = normalizePhoneNumber(args.number)
  if (!digits) return { ok: false, message: `"${args.number}" is not a phone number Twilio can sell.` }
  if (!args.personId) return { ok: false, message: 'Pick the agent who answers this number.' }

  const line = await ensureCarrierTrunk(args.tenantId, client)
  if (!line.ok) return line

  const label = args.label.trim() || `+${digits}`
  let purchased
  try {
    purchased = await client.buyNumber({
      number: `+${digits}`,
      label,
      carrierTrunkId: line.trunk.carrierTrunkSid!,
    })
  } catch (error) {
    return { ok: false, message: describe(error, 'Twilio could not sell that number') }
  }

  const bought = normalizePhoneNumber(purchased.number) ?? digits
  const assigned = await assignPhoneNumber({
    tenantId: args.tenantId,
    number: bought,
    label,
    personId: args.personId,
    trunkId: line.trunk.id,
    provider: 'twilio',
    providerSid: purchased.numberId,
  })
  if (!assigned.ok) {
    // The number is bought and billing. Handing it straight back is the only
    // honest outcome when it cannot be recorded as anyone's.
    await client.releaseNumber(purchased.numberId).catch(() => undefined)
    return assigned
  }
  return { ok: true, number: bought, trunkName: line.trunk.name }
}

/**
 * Give up a number. One bought here goes back to the carrier; one an operator
 * typed in was never ours to release, so only the mapping goes.
 */
export async function releaseCarrierNumber(
  tenantId: string,
  numberId: string,
): Promise<{ ok: true; released: boolean } | { ok: false; message: string }> {
  const app = db()
  const [row] = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ provider: phoneNumbers.provider, providerSid: phoneNumbers.providerSid })
      .from(phoneNumbers)
      .where(eq(phoneNumbers.id, numberId)),
  )
  if (!row) return { ok: true, released: false }
  if (row.provider !== 'twilio' || !row.providerSid) {
    await removePhoneNumber(tenantId, numberId)
    return { ok: true, released: false }
  }
  const client = await carrierClient(tenantId)
  if (!client) {
    return {
      ok: false,
      message:
        'This number was bought through Twilio, but no Twilio account is connected to hand it back. Reconnect the account first, or release it in the Twilio console.',
    }
  }
  try {
    await client.releaseNumber(row.providerSid)
  } catch (error) {
    // A number already gone from the carrier should not be stuck here forever.
    if (error instanceof CarrierError && error.status === 404) {
      await removePhoneNumber(tenantId, numberId)
      return { ok: true, released: true }
    }
    return { ok: false, message: describe(error, 'Twilio would not release that number') }
  }
  await removePhoneNumber(tenantId, numberId)
  return { ok: true, released: true }
}
