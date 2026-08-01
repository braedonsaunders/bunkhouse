'use server'

import { revalidatePath } from 'next/cache'
import {
  assignExtension,
  assignPhoneNumber,
  createSipTrunk,
  deletePbxExtension,
  deleteSipTrunk,
  listPbxExtensions,
  listSipTrunks,
  normalizePhoneNumber,
  probeAllTrunks,
  probeTrunkHealth,
  listPhoneNumbers,
  refreshBridgeRegistrations,
  republishBridge,
  savePbxExtension,
  sipIngressAddress,
  updateSipTrunk,
  type SipTrunkInput,
} from '../../../lib/pbx'
import {
  buyCarrierNumber,
  getCarrierSettings,
  releaseCarrierNumber,
  removeTwilioCredentials,
  saveTwilioCredentials,
  searchCarrierNumbers,
} from '../../../lib/carrier'
import { placeTestCall, type TestCallResult } from '../../../lib/outbound-call'
import { people } from '../../../db/schema'
import { db } from '../../../db/client'
import { and, asc, eq } from 'drizzle-orm'
import { resolveTenantId as resolveTenant } from '../../../lib/tenant'
const resolveTenantId = () => resolveTenant('settings.manage')

export type SipTrunkFormInput = {
  id?: string
  name: string
  flavor: 'avaya_ip_office' | 'generic_sip' | 'twilio_sip'
  mode: 'trunk' | 'extension'
  dialScope: 'internal' | 'external' | 'both'
  /** Default outbound caller id, as typed. */
  callerId: string
  pbxHost: string
  pbxPort: string
  transport: 'udp' | 'tcp' | 'tls'
  srtp: 'disabled' | 'best_effort' | 'required'
  /** Blank leaves the session timer unset. */
  sessionTimerSeconds: string
  /** One address per line, as typed by the operator. */
  allowedAddresses: string
  testExtension: string
  authUsername: string
  /** Empty string clears the stored password; undefined leaves it sealed. */
  authPassword?: string
  extensionRange: string
}

/** Create or update a PBX trunk; the row is re-mirrored to the SIP ingress. */
export async function saveSipTrunkAction(
  input: SipTrunkFormInput,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const name = input.name.trim()
  if (!name) return { ok: false, message: 'Give the trunk a name.' }
  const port = input.pbxPort.trim() ? Number(input.pbxPort) : 5060
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, message: 'Port must be a number between 1 and 65535.' }
  }
  const timerRaw = input.sessionTimerSeconds.trim()
  const sessionTimerSeconds = timerRaw ? Number(timerRaw) : null
  if (sessionTimerSeconds !== null && (!Number.isInteger(sessionTimerSeconds) || sessionTimerSeconds < 90)) {
    return { ok: false, message: 'The session timer is a whole number of seconds, 90 or more (1800 is typical).' }
  }
  const testExtension = input.testExtension.trim()
  if (testExtension && !/^[0-9+][0-9]{1,14}$/.test(testExtension)) {
    return { ok: false, message: 'The test extension is a dialable number, e.g. 201.' }
  }
  const callerId = input.callerId.trim()
  if (callerId && !normalizePhoneNumber(callerId)) {
    return { ok: false, message: 'The caller id is a full number with country code, e.g. +1 555 123 4567.' }
  }
  const payload: SipTrunkInput = {
    name,
    flavor: input.flavor,
    mode: input.mode,
    dialScope: input.dialScope,
    callerId,
    pbxHost: input.pbxHost,
    pbxPort: port,
    transport: input.transport,
    srtp: input.srtp,
    sessionTimerSeconds,
    allowedAddresses: input.allowedAddresses.split('\n'),
    testExtension,
    authUsername: input.authUsername,
    ...(input.authPassword !== undefined ? { authPassword: input.authPassword } : {}),
    extensionRange: input.extensionRange,
  }
  try {
    const tenantId = await resolveTenantId()
    if (input.id) await updateSipTrunk(tenantId, input.id, payload)
    else await createSipTrunk(tenantId, payload)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  revalidatePath('/admin/settings')
  return { ok: true }
}

/** Remove a trunk and its mirrored SIP ingress objects. */
export async function deleteSipTrunkAction(trunkId: string): Promise<void> {
  const tenantId = await resolveTenantId()
  await deleteSipTrunk(tenantId, trunkId)
  revalidatePath('/admin/settings')
}

/** Set or clear an agent's phone extension (unique per company). */
export async function setAgentExtensionAction(input: {
  personId: string
  extension: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const tenantId = await resolveTenantId()
  const result = await assignExtension({
    tenantId,
    personId: input.personId,
    extension: input.extension.trim() || null,
  })
  if (result.ok) {
    revalidatePath('/organization')
    revalidatePath('/admin/settings')
  }
  return result
}

/** Point a real phone number at an agent (carrier path). */
export async function assignPhoneNumberAction(input: {
  number: string
  label: string
  personId: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const tenantId = await resolveTenantId()
  const result = await assignPhoneNumber({ tenantId, ...input })
  if (result.ok) revalidatePath('/admin/settings')
  return result
}

/**
 * Give up a number. A number bought through the connected carrier account goes
 * back to it; one an operator typed in was never ours to release, so only the
 * mapping goes.
 */
export async function removePhoneNumberAction(
  numberId: string,
): Promise<{ ok: true; released: boolean } | { ok: false; message: string }> {
  const tenantId = await resolveTenantId()
  const result = await releaseCarrierNumber(tenantId, numberId)
  if (result.ok) revalidatePath('/admin/settings')
  return result
}

// ---------------------------------------------------------------------------
// The carrier account — buying numbers without leaving the app
// ---------------------------------------------------------------------------

/** Connect a Twilio account. The credentials are checked against Twilio before
 *  they are stored, and the token is sealed at rest. */
export async function saveCarrierAccountAction(input: {
  accountSid: string
  authToken: string
}): Promise<{ ok: true; friendlyName: string } | { ok: false; message: string }> {
  const tenantId = await resolveTenantId()
  const result = await saveTwilioCredentials({ tenantId, ...input })
  if (result.ok) revalidatePath('/admin/settings')
  return result
}

export async function removeCarrierAccountAction(): Promise<void> {
  const tenantId = await resolveTenantId()
  await removeTwilioCredentials(tenantId)
  revalidatePath('/admin/settings')
}

export type NumberSearchRow = {
  number: string
  friendlyName: string
  locality: string
  region: string
  sms: boolean
}

/** Numbers the carrier has for sale, matching what the operator asked for. */
export async function searchCarrierNumbersAction(input: {
  country: string
  areaCode: string
  contains: string
}): Promise<{ ok: true; numbers: NumberSearchRow[] } | { ok: false; message: string }> {
  const tenantId = await resolveTenantId()
  const result = await searchCarrierNumbers({
    tenantId,
    country: input.country,
    areaCode: input.areaCode,
    contains: input.contains,
  })
  if (!result.ok) return result
  return {
    ok: true,
    numbers: result.numbers.map((row) => ({
      number: row.number,
      friendlyName: row.label,
      locality: row.locality,
      region: row.region,
      sms: row.sms,
    })),
  }
}

/** Buy one of those numbers and put an agent on it. */
export async function buyCarrierNumberAction(input: {
  number: string
  label: string
  personId: string
}): Promise<{ ok: true; number: string; trunkName: string } | { ok: false; message: string }> {
  const tenantId = await resolveTenantId()
  const result = await buyCarrierNumber({ tenantId, ...input })
  if (result.ok) revalidatePath('/admin/settings')
  return result
}

// ---------------------------------------------------------------------------
// Live state: everything the Phone system drawer reads while it is open
// ---------------------------------------------------------------------------

export type TrunkDetailView = {
  id: string
  name: string
  flavor: 'avaya_ip_office' | 'generic_sip' | 'twilio_sip'
  mode: 'trunk' | 'extension'
  dialScope: 'internal' | 'external' | 'both'
  callerId: string
  /** True when this deployment provisioned the line on a carrier account —
   *  its address and credentials belong to the carrier, not the operator. */
  carrierManaged: boolean
  pbxHost: string
  pbxPort: number
  transport: 'udp' | 'tcp' | 'tls'
  srtp: 'disabled' | 'best_effort' | 'required'
  sessionTimerSeconds: string
  allowedAddresses: string
  testExtension: string
  authUsername: string
  hasPassword: boolean
  extensionRange: string
  status: 'unconfigured' | 'active' | 'error'
  lastError: string
  health: 'unknown' | 'ok' | 'unreachable'
  healthDetail: string
  lastSeenAt: string
}

export type BridgeExtensionView = {
  id: string
  trunkId: string
  trunkName: string
  extension: string
  personId: string
  personName: string
  authUsername: string
  hasPassword: boolean
  regStatus: 'unregistered' | 'registered' | 'failed'
  regExpiresAt: string
  lastError: string
}

export type PhoneNumberDetailView = {
  id: string
  number: string
  label: string
  personName: string
  /** 'manual' when an operator typed it in, 'twilio' when it was bought here. */
  provider: 'manual' | 'twilio'
}

export type PhoneSystemDetail = {
  trunks: TrunkDetailView[]
  bridgeExtensions: BridgeExtensionView[]
  /** Read here rather than passed in, so buying a number updates the drawer
   *  without a page load. */
  numbers: PhoneNumberDetailView[]
  agents: { id: string; name: string; title: string }[]
  ingress: { host: string; port: number } | null
  /** The connected carrier account's SID, or null when none is connected. */
  carrierAccountSid: string | null
}

function stamp(value: Date | null): string {
  return value ? value.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : ''
}

/** Everything the drawer shows, read fresh each time it opens or a save lands. */
export async function loadPhoneSystemDetailAction(): Promise<PhoneSystemDetail> {
  const tenantId = await resolveTenantId()
  const app = db()
  const [trunks, bridgeExtensions, numbers, carrier, agents] = await Promise.all([
    listSipTrunks(tenantId),
    listPbxExtensions(tenantId),
    listPhoneNumbers(tenantId),
    getCarrierSettings(tenantId),
    app.withTenantContext(tenantId, () =>
      app.db
        .select({ id: people.id, name: people.name, title: people.title })
        .from(people)
        .where(and(eq(people.kind, 'agent'), eq(people.status, 'active')))
        .orderBy(asc(people.name)),
    ),
  ])
  return {
    trunks: trunks
      .map((trunk) => ({
        id: trunk.id,
        name: trunk.name,
        flavor: trunk.flavor,
        mode: trunk.mode,
        dialScope: trunk.dialScope,
        callerId: trunk.callerId ?? '',
        carrierManaged: trunk.carrierTrunkSid !== null,
        pbxHost: trunk.pbxHost ?? '',
        pbxPort: trunk.pbxPort,
        transport: trunk.transport,
        srtp: trunk.srtp,
        sessionTimerSeconds: trunk.sessionTimerSeconds === null ? '' : String(trunk.sessionTimerSeconds),
        allowedAddresses: trunk.allowedAddresses.join('\n'),
        testExtension: trunk.testExtension ?? '',
        authUsername: trunk.authUsername ?? '',
        hasPassword: trunk.sealedAuthPassword !== null,
        extensionRange: trunk.extensionRange ?? '',
        status: trunk.status,
        lastError: trunk.lastError ?? '',
        health: trunk.health,
        healthDetail: trunk.healthDetail ?? '',
        lastSeenAt: stamp(trunk.lastSeenAt),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    bridgeExtensions: bridgeExtensions.map((row) => ({
      id: row.id,
      trunkId: row.trunkId,
      trunkName: row.trunkName,
      extension: row.extension,
      personId: row.personId,
      personName: row.personName,
      authUsername: row.authUsername ?? '',
      hasPassword: row.hasPassword,
      regStatus: row.regStatus,
      regExpiresAt: stamp(row.regExpiresAt),
      lastError: row.lastError ?? '',
    })),
    numbers: numbers
      .map((row) => ({
        id: row.id,
        number: row.number,
        label: row.label,
        personName: row.personName,
        provider: row.provider,
      }))
      .sort((a, b) => a.number.localeCompare(b.number)),
    agents,
    ingress: sipIngressAddress(),
    carrierAccountSid: carrier.accountId,
  }
}

// ---------------------------------------------------------------------------
// Trunk health and the test call
// ---------------------------------------------------------------------------

/** Send a SIP OPTIONS keepalive to one trunk and record what came back. */
export async function probeTrunkHealthAction(trunkId: string): Promise<{ health: string; detail: string }> {
  const tenantId = await resolveTenantId()
  const result = await probeTrunkHealth(tenantId, trunkId)
  revalidatePath('/admin/settings')
  return { health: result.health, detail: result.detail }
}

/** Check every trunk the company has. */
export async function probeAllTrunksAction(): Promise<{ checked: number; reachable: number }> {
  const tenantId = await resolveTenantId()
  const results = await probeAllTrunks(tenantId)
  revalidatePath('/admin/settings')
  return { checked: results.length, reachable: results.filter((entry) => entry.health === 'ok').length }
}

/** Dial a test extension over the trunk and report the SIP exchange. */
export async function testTrunkCallAction(input: {
  trunkId: string
  extension: string
}): Promise<TestCallResult> {
  const tenantId = await resolveTenantId()
  if (!input.extension.trim()) {
    return {
      ok: false,
      steps: [],
      summary: 'Enter an extension on the phone system to dial — a desk phone you can hear ring.',
    }
  }
  return placeTestCall({ tenantId, trunkId: input.trunkId, extension: input.extension })
}

// ---------------------------------------------------------------------------
// The extension map (registered-extensions mode)
// ---------------------------------------------------------------------------

export type BridgeExtensionFormInput = {
  id?: string
  trunkId: string
  extension: string
  personId: string
  authUsername: string
  /** Empty string clears the stored password; undefined leaves it sealed. */
  authPassword?: string
}

export async function saveBridgeExtensionAction(
  input: BridgeExtensionFormInput,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const tenantId = await resolveTenantId()
  const result = await savePbxExtension(tenantId, {
    ...(input.id ? { id: input.id } : {}),
    trunkId: input.trunkId,
    extension: input.extension,
    personId: input.personId,
    authUsername: input.authUsername,
    ...(input.authPassword !== undefined ? { authPassword: input.authPassword } : {}),
  })
  if (result.ok) {
    revalidatePath('/admin/settings')
    revalidatePath('/organization')
  }
  return result
}

export async function deleteBridgeExtensionAction(extensionId: string): Promise<void> {
  const tenantId = await resolveTenantId()
  await deletePbxExtension(tenantId, extensionId)
  revalidatePath('/admin/settings')
}

/** Read the bridge's live registration state onto the extension map. */
export async function refreshBridgeRegistrationsAction(): Promise<{ ok: boolean; detail: string }> {
  const tenantId = await resolveTenantId()
  const result = await refreshBridgeRegistrations(tenantId)
  if (result.ok) revalidatePath('/admin/settings')
  return { ok: result.ok, detail: result.detail }
}

/** Re-publish the bridge configuration and ask it to register again. */
export async function republishBridgeAction(): Promise<{ ok: boolean; detail: string }> {
  const tenantId = await resolveTenantId()
  const published = await republishBridge()
  if (!published.ok) return published
  const refreshed = await refreshBridgeRegistrations(tenantId)
  revalidatePath('/admin/settings')
  return {
    ok: true,
    detail: refreshed.ok ? `${published.detail} ${refreshed.detail}` : published.detail,
  }
}
