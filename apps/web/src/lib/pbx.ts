import 'server-only'
import { and, eq, ne } from 'drizzle-orm'
import { SipClient, type CreateSipInboundTrunkOptions } from 'livekit-server-sdk'
import { sealSecret, unsealSecret } from '@braedonsaunders/appkit-crypto'
import { pbxExtensions, people, phoneNumbers, sipTrunks } from '../db/schema'
import { db } from '../db/client'
import {
  bridgeDeployment,
  publishBridgeConfig,
  scrapePjsipRegistrations,
  type BridgeExtension,
} from './asterisk-bridge'
import { sipOptionsPing } from './sip-probe'

/**
 * The phone system: tenant PBX trunks and agent extensions. A trunk row is
 * the single source of truth; saving one mirrors it to the LiveKit SIP
 * ingress (inbound trunk + callee dispatch rule that creates `pbx-<ext>…`
 * rooms the voice agent answers). Mirroring is reconstruct-on-save: the
 * previous LiveKit objects are removed and fresh ones created, and their
 * ids stored on the row — deterministic, idempotent, and safe to repeat.
 *
 * A trunk in 'extension' mode takes the same shape, but the phone system
 * never sees the ingress: the bridge REGISTERs to it as one endpoint per
 * mapped agent (the pbx_extensions rows) and hands answered calls on. Saving
 * such a trunk republishes the bridge's generated configuration.
 */

export type SipTrunkRow = typeof sipTrunks.$inferSelect
export type PbxExtensionRow = typeof pbxExtensions.$inferSelect

export type SipTrunkInput = {
  name: string
  flavor: 'avaya_ip_office' | 'generic_sip' | 'twilio_sip'
  mode?: 'trunk' | 'extension'
  /** What the line carries. Defaults to 'both', which is every line that
   *  existed before a company could have more than one kind. */
  dialScope?: 'internal' | 'external' | 'both'
  /** Default outbound caller id for this line, as typed; normalized here. */
  callerId?: string | null
  /** The carrier's id for a trunk this deployment provisioned. */
  carrierTrunkSid?: string | null
  pbxHost?: string | null
  pbxPort?: number
  transport?: 'udp' | 'tcp' | 'tls'
  srtp?: 'disabled' | 'best_effort' | 'required'
  /** RFC 4028 session expiry, matched to the phone system's line. */
  sessionTimerSeconds?: number | null
  /** Addresses the ingress accepts INVITEs from for this trunk. */
  allowedAddresses?: string[]
  /** The extension the Test call button dials. */
  testExtension?: string | null
  authUsername?: string | null
  /** Plain password; sealed here. Undefined = leave the stored one alone. */
  authPassword?: string | null
  extensionRange?: string | null
}

function livekitEnv(): { host: string; apiKey: string; apiSecret: string } | null {
  const url = process.env.LIVEKIT_URL
  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET
  if (!url || !apiKey || !apiSecret) return null
  // SipClient speaks HTTP against the same endpoint the ws URL names.
  const host = url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:')
  return { host, apiKey, apiSecret }
}

/** The address a PBX points its SIP line at — deployment infrastructure,
 *  derived from the LiveKit media plane's host. */
export function sipIngressAddress(): { host: string; port: number } | null {
  const url = process.env.LIVEKIT_URL
  if (!url) return null
  try {
    return { host: new URL(url).hostname, port: 5060 }
  } catch {
    return null
  }
}

export async function listSipTrunks(tenantId: string): Promise<SipTrunkRow[]> {
  const app = db()
  return app.withTenantContext(tenantId, () => app.db.select().from(sipTrunks))
}

// livekit.SIPMediaEncryption wire values (DISABLE 0, ALLOW 1, REQUIRE 2). The
// generated enum lives in @livekit/protocol — a transitive dependency of the
// server SDK that this package does not resolve — so the values are named here.
type SipMediaEncryptionValue = NonNullable<CreateSipInboundTrunkOptions['mediaEncryption']>

const SIP_MEDIA_ENCRYPTION: Record<SipTrunkRow['srtp'], SipMediaEncryptionValue> = {
  disabled: 0 as SipMediaEncryptionValue,
  best_effort: 1 as SipMediaEncryptionValue,
  required: 2 as SipMediaEncryptionValue,
}

/**
 * The addresses the SIP ingress accepts this trunk's calls from. On a SIP line
 * the phone system itself is the sender, so its address is always allowed
 * alongside anything the operator added. Through the bridge the sender is the
 * bridge container, never the phone system — so only the authored list applies,
 * plus the bridge's own address when the deployment publishes one.
 *
 * A carrier is the exception: its pbxHost is where calls are sent *to*
 * (the trunk's termination domain), and calls arrive from the carrier's
 * signalling ranges, which are on the authored list instead. Implying the
 * termination domain here would allowlist a hostname that never dials in.
 */
function ingressAllowlist(trunk: SipTrunkRow): string[] {
  const authored = trunk.allowedAddresses.map((entry) => entry.trim()).filter(Boolean)
  const implied =
    trunk.mode === 'trunk'
      ? trunk.pbxHost && trunk.flavor !== 'twilio_sip'
        ? [trunk.pbxHost]
        : []
      : process.env.BUNKHOUSE_BRIDGE_SIP_ADDRESS
        ? [process.env.BUNKHOUSE_BRIDGE_SIP_ADDRESS]
        : []
  return [...new Set([...implied, ...authored])]
}

/** Mirror one trunk row to the LiveKit SIP service. Returns the row's new
 *  status fields; never throws — provisioning failures land on the row. */
async function provisionTrunk(
  tenantId: string,
  trunk: SipTrunkRow,
): Promise<Pick<SipTrunkRow, 'status' | 'lastError' | 'livekitTrunkId' | 'livekitDispatchRuleId'>> {
  const env = livekitEnv()
  if (!env) {
    return { status: 'unconfigured', lastError: null, livekitTrunkId: null, livekitDispatchRuleId: null }
  }
  const client = new SipClient(env.host, env.apiKey, env.apiSecret)
  try {
    // Reconstruct: drop the previous mirrored objects (ignore "already gone"),
    // then create fresh ones. Re-running converges on the same state.
    if (trunk.livekitDispatchRuleId) {
      await client.deleteSipDispatchRule(trunk.livekitDispatchRuleId).catch(() => undefined)
    }
    if (trunk.livekitTrunkId) {
      await client.deleteSipTrunk(trunk.livekitTrunkId).catch(() => undefined)
    }
    // On a carrier line the stored credentials are termination credentials —
    // what this deployment presents when it sends a call *out* to the carrier.
    // A carrier delivering a call *in* does not authenticate at all, so asking
    // the ingress to challenge it would refuse every inbound call. Its
    // signalling ranges on the allowlist are the inbound control instead.
    const inboundAuth = trunk.flavor !== 'twilio_sip'
    const password = inboundAuth && trunk.sealedAuthPassword ? unsealSecret(trunk.sealedAuthPassword) : null
    const allowedAddresses = ingressAllowlist(trunk)
    const created = await client.createSipInboundTrunk(`bunkhouse-${trunk.id}`, [], {
      ...(allowedAddresses.length > 0 ? { allowedAddresses } : {}),
      ...(inboundAuth && trunk.authUsername ? { authUsername: trunk.authUsername } : {}),
      ...(password ? { authPassword: password } : {}),
      mediaEncryption: SIP_MEDIA_ENCRYPTION[trunk.srtp],
      metadata: JSON.stringify({ tenantId, trunkId: trunk.id }),
    })
    const rule = await client.createSipDispatchRule(
      // Callee dispatch: the dialed extension names the room (`pbx-<ext>` plus
      // a random suffix so every call is its own room/session).
      { type: 'callee', roomPrefix: 'pbx-', randomize: true },
      {
        name: `bunkhouse-${trunk.id}`,
        trunkIds: [created.sipTrunkId],
        attributes: { 'bunkhouse.tenantId': tenantId, 'bunkhouse.trunkId': trunk.id },
      },
    )
    return {
      status: 'active',
      lastError: null,
      livekitTrunkId: created.sipTrunkId,
      livekitDispatchRuleId: rule.sipDispatchRuleId,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      status: 'error',
      lastError: `Provisioning failed: ${message}`,
      livekitTrunkId: trunk.livekitTrunkId,
      livekitDispatchRuleId: trunk.livekitDispatchRuleId,
    }
  }
}

export async function createSipTrunk(tenantId: string, input: SipTrunkInput): Promise<SipTrunkRow> {
  const app = db()
  const inserted = await app.withTenant(tenantId, async () => {
    const [row] = await app.db
      .insert(sipTrunks)
      .values({
        tenantId,
        name: input.name.trim(),
        flavor: input.flavor,
        mode: input.mode ?? 'trunk',
        pbxHost: input.pbxHost?.trim() || null,
        pbxPort: input.pbxPort ?? 5060,
        transport: input.transport ?? 'udp',
        srtp: input.srtp ?? 'disabled',
        sessionTimerSeconds: input.sessionTimerSeconds ?? null,
        allowedAddresses: normalizeAllowlist(input.allowedAddresses),
        testExtension: input.testExtension?.trim() || null,
        authUsername: input.authUsername?.trim() || null,
        sealedAuthPassword: input.authPassword ? sealSecret(input.authPassword) : null,
        extensionRange: input.extensionRange?.trim() || null,
        dialScope: input.dialScope ?? 'both',
        callerId: input.callerId ? normalizePhoneNumber(input.callerId) : null,
        carrierTrunkSid: input.carrierTrunkSid ?? null,
      })
      .returning()
    return row!
  })
  return finishProvision(tenantId, inserted)
}

export async function updateSipTrunk(tenantId: string, trunkId: string, input: SipTrunkInput): Promise<SipTrunkRow> {
  const app = db()
  const updated = await app.withTenant(tenantId, async () => {
    const [current] = await app.db.select().from(sipTrunks).where(eq(sipTrunks.id, trunkId))
    if (!current) throw new Error('This trunk no longer exists.')
    const [row] = await app.db
      .update(sipTrunks)
      .set({
        name: input.name.trim(),
        flavor: input.flavor,
        mode: input.mode ?? current.mode,
        pbxHost: input.pbxHost?.trim() || null,
        pbxPort: input.pbxPort ?? 5060,
        transport: input.transport ?? 'udp',
        srtp: input.srtp ?? 'disabled',
        sessionTimerSeconds: input.sessionTimerSeconds ?? null,
        allowedAddresses: normalizeAllowlist(input.allowedAddresses),
        testExtension: input.testExtension?.trim() || null,
        authUsername: input.authUsername?.trim() || null,
        // Undefined leaves the sealed password untouched; empty string clears it.
        ...(input.authPassword !== undefined
          ? { sealedAuthPassword: input.authPassword ? sealSecret(input.authPassword) : null }
          : {}),
        extensionRange: input.extensionRange?.trim() || null,
        dialScope: input.dialScope ?? current.dialScope,
        // A carrier trunk's caller id and SID are provisioning facts, not form
        // fields — undefined leaves whatever provisioning wrote.
        ...(input.callerId !== undefined
          ? { callerId: input.callerId ? normalizePhoneNumber(input.callerId) : null }
          : {}),
        ...(input.carrierTrunkSid !== undefined ? { carrierTrunkSid: input.carrierTrunkSid } : {}),
        updatedAt: new Date(),
      })
      .where(eq(sipTrunks.id, trunkId))
      .returning()
    return row!
  })
  return finishProvision(tenantId, updated)
}

/** One address per line or comma, de-duplicated, order preserved. */
function normalizeAllowlist(entries: string[] | undefined): string[] {
  if (!entries) return []
  const cleaned = entries
    .flatMap((entry) => entry.split(/[\s,]+/))
    .map((entry) => entry.trim())
    .filter(Boolean)
  return [...new Set(cleaned)]
}

async function finishProvision(tenantId: string, trunk: SipTrunkRow): Promise<SipTrunkRow> {
  const app = db()
  const result = await provisionTrunk(tenantId, trunk)
  const saved = await app.withTenant(tenantId, async () => {
    const [row] = await app.db
      .update(sipTrunks)
      .set({ ...result, updatedAt: new Date() })
      .where(eq(sipTrunks.id, trunk.id))
      .returning()
    return row!
  })
  // The bridge's configuration is derived from these rows, so a saved trunk
  // republishes it — the generated files are never edited by hand.
  await republishBridge()
  return saved
}

export async function deleteSipTrunk(tenantId: string, trunkId: string): Promise<void> {
  const app = db()
  const [trunk] = await app.withTenantContext(tenantId, () =>
    app.db.select().from(sipTrunks).where(eq(sipTrunks.id, trunkId)),
  )
  if (!trunk) return
  const env = livekitEnv()
  if (env) {
    const client = new SipClient(env.host, env.apiKey, env.apiSecret)
    if (trunk.livekitDispatchRuleId) await client.deleteSipDispatchRule(trunk.livekitDispatchRuleId).catch(() => undefined)
    if (trunk.livekitTrunkId) await client.deleteSipTrunk(trunk.livekitTrunkId).catch(() => undefined)
  }
  await app.withTenant(tenantId, async () => {
    await app.db.delete(sipTrunks).where(eq(sipTrunks.id, trunkId))
  })
  await republishBridge()
}

// ---------------------------------------------------------------------------
// Trunk health — the SIP OPTIONS keepalive
// ---------------------------------------------------------------------------

export type TrunkHealthResult = {
  trunkId: string
  health: SipTrunkRow['health']
  detail: string
  lastSeenAt: Date | null
}

/**
 * Ask one trunk's phone system whether it is there, and record the answer.
 * Any SIP response proves the address is live and speaking SIP — even a 403 —
 * so the status line is stored verbatim rather than being judged as a failure.
 */
export async function probeTrunkHealth(tenantId: string, trunkId: string): Promise<TrunkHealthResult> {
  const app = db()
  const [trunk] = await app.withTenantContext(tenantId, () =>
    app.db.select().from(sipTrunks).where(eq(sipTrunks.id, trunkId)),
  )
  if (!trunk) {
    return { trunkId, health: 'unknown', detail: 'This trunk no longer exists.', lastSeenAt: null }
  }
  if (!trunk.pbxHost) {
    const detail = 'No phone system address is set, so there is nothing to check.'
    await app.withTenant(tenantId, async () => {
      await app.db
        .update(sipTrunks)
        .set({ health: 'unknown', healthDetail: detail, updatedAt: new Date() })
        .where(eq(sipTrunks.id, trunkId))
    })
    return { trunkId, health: 'unknown', detail, lastSeenAt: trunk.lastSeenAt }
  }
  const probe = await sipOptionsPing({
    host: trunk.pbxHost,
    port: trunk.pbxPort,
    transport: trunk.transport,
  })
  const now = new Date()
  const health: SipTrunkRow['health'] = probe.reachable ? 'ok' : 'unreachable'
  const detail = probe.reachable
    ? `${probe.detail}${probe.latencyMs === null ? '' : ` · ${probe.latencyMs} ms`}`
    : probe.detail
  await app.withTenant(tenantId, async () => {
    await app.db
      .update(sipTrunks)
      .set({
        health,
        healthDetail: detail,
        ...(probe.reachable ? { lastSeenAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(sipTrunks.id, trunkId))
  })
  return { trunkId, health, detail, lastSeenAt: probe.reachable ? now : trunk.lastSeenAt }
}

/**
 * Probe every trunk a company has. Exported for scheduling — the keepalive is
 * only worth anything when it runs on a cadence.
 */
export async function probeAllTrunks(tenantId: string): Promise<TrunkHealthResult[]> {
  const trunks = await listSipTrunks(tenantId)
  const results: TrunkHealthResult[] = []
  for (const trunk of trunks) {
    results.push(await probeTrunkHealth(tenantId, trunk.id))
  }
  return results
}

// ---------------------------------------------------------------------------
// The extension map — registered-extensions mode
// ---------------------------------------------------------------------------

export type PbxExtensionView = PbxExtensionRow & {
  personName: string
  trunkName: string
  hasPassword: boolean
}

export async function listPbxExtensions(tenantId: string): Promise<PbxExtensionView[]> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const rows = await app.db
      .select({ row: pbxExtensions, personName: people.name, trunkName: sipTrunks.name })
      .from(pbxExtensions)
      .innerJoin(people, eq(people.id, pbxExtensions.personId))
      .innerJoin(sipTrunks, eq(sipTrunks.id, pbxExtensions.trunkId))
    return rows
      .map((entry) => ({
        ...entry.row,
        personName: entry.personName,
        trunkName: entry.trunkName,
        hasPassword: entry.row.sealedAuthPassword !== null,
      }))
      .sort((a, b) => a.extension.localeCompare(b.extension, 'en', { numeric: true }))
  })
}

export type PbxExtensionInput = {
  id?: string
  trunkId: string
  extension: string
  personId: string
  authUsername?: string | null
  /** Plain password; sealed here. Undefined leaves the stored one alone. */
  authPassword?: string | null
}

/**
 * Map an agent onto an extension of a phone system the bridge registers to.
 * The agent's own extension is kept in step, because a call routed here and a
 * call routed over a SIP line must reach the same agent — the extension an
 * agent answers on is one fact, not two.
 */
export async function savePbxExtension(
  tenantId: string,
  input: PbxExtensionInput,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const extension = input.extension.trim()
  if (!/^[0-9]{2,6}$/.test(extension)) {
    return { ok: false, message: 'An extension is 2–6 digits, e.g. 701.' }
  }
  const app = db()
  const outcome = await app.withTenant(tenantId, async () => {
    const [trunk] = await app.db.select().from(sipTrunks).where(eq(sipTrunks.id, input.trunkId))
    if (!trunk) return { ok: false as const, message: 'That phone system no longer exists.' }
    if (trunk.mode !== 'extension') {
      return {
        ok: false as const,
        message: `"${trunk.name}" is set up as a SIP line, so it has no registered extensions. Switch it to registered extensions first.`,
      }
    }
    const [agent] = await app.db
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.id, input.personId), eq(people.kind, 'agent'), eq(people.status, 'active')))
    if (!agent) return { ok: false as const, message: 'Pick an active agent to answer this extension.' }

    const values = {
      tenantId,
      trunkId: input.trunkId,
      extension,
      personId: input.personId,
      authUsername: input.authUsername?.trim() || null,
      ...(input.authPassword !== undefined
        ? { sealedAuthPassword: input.authPassword ? sealSecret(input.authPassword) : null }
        : {}),
    }
    if (input.id) {
      await app.db
        .update(pbxExtensions)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(pbxExtensions.id, input.id))
    } else {
      const [taken] = await app.db
        .select({ id: pbxExtensions.id })
        .from(pbxExtensions)
        .where(and(eq(pbxExtensions.trunkId, input.trunkId), eq(pbxExtensions.extension, extension)))
      if (taken) {
        return { ok: false as const, message: `Extension ${extension} is already mapped on "${trunk.name}".` }
      }
      await app.db.insert(pbxExtensions).values(values)
    }
    return { ok: true as const }
  })
  if (!outcome.ok) return outcome
  const assigned = await assignExtension({ tenantId, personId: input.personId, extension })
  if (!assigned.ok) return assigned
  await republishBridge()
  return { ok: true }
}

export async function deletePbxExtension(tenantId: string, extensionId: string): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db.delete(pbxExtensions).where(eq(pbxExtensions.id, extensionId))
  })
  await republishBridge()
}

// ---------------------------------------------------------------------------
// The bridge: generated configuration and registration state
// ---------------------------------------------------------------------------

/**
 * Every mapped endpoint across the deployment, with credentials unsealed —
 * the bridge container is one process serving every company, so its
 * configuration is rendered from all of them at once.
 */
async function collectBridgeExtensions(): Promise<BridgeExtension[]> {
  const app = db()
  return app.withSuperAdmin(async (superDb) => {
    const rows = await superDb
      .select({ row: pbxExtensions, trunk: sipTrunks, personName: people.name })
      .from(pbxExtensions)
      .innerJoin(sipTrunks, eq(sipTrunks.id, pbxExtensions.trunkId))
      .innerJoin(people, eq(people.id, pbxExtensions.personId))
      .where(and(eq(sipTrunks.mode, 'extension'), eq(people.status, 'active')))
    return rows
      .filter((entry) => Boolean(entry.trunk.pbxHost))
      .map((entry) => ({
        id: entry.row.id,
        tenantId: entry.row.tenantId,
        trunkId: entry.row.trunkId,
        trunkName: entry.trunk.name,
        extension: entry.row.extension,
        personName: entry.personName,
        pbxHost: entry.trunk.pbxHost!,
        pbxPort: entry.trunk.pbxPort,
        transport: entry.trunk.transport,
        srtp: entry.trunk.srtp,
        sessionTimerSeconds: entry.trunk.sessionTimerSeconds,
        authUsername: entry.row.authUsername,
        authPassword: entry.row.sealedAuthPassword ? unsealSecret(entry.row.sealedAuthPassword) : null,
      }))
  })
}

/**
 * Regenerate and publish the bridge's configuration. A deployment without the
 * bridge simply has nothing to publish to, which is not a failure — so this
 * never throws into a save path.
 */
export async function republishBridge(): Promise<{ ok: boolean; detail: string }> {
  const deployment = bridgeDeployment()
  if (!deployment) {
    return { ok: true, detail: 'The extension bridge is not part of this deployment.' }
  }
  try {
    const extensions = await collectBridgeExtensions()
    const result = await publishBridgeConfig({
      extensions,
      ingress: deployment.ingress,
      bindPort: deployment.bindPort,
      rtpPorts: deployment.rtpPorts,
    })
    return result.published ? { ok: true, detail: result.detail } : { ok: false, detail: result.detail }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Read the bridge's live registration state onto the extension rows. Exported
 * for scheduling: registration is a running state, not a saved one.
 */
export async function refreshBridgeRegistrations(
  tenantId: string,
): Promise<{ ok: boolean; detail: string; updated: number }> {
  const scrape = await scrapePjsipRegistrations()
  if (!scrape.ok) return { ok: false, detail: scrape.detail, updated: 0 }
  const byId = new Map(scrape.registrations.map((entry) => [entry.extensionId, entry]))
  const app = db()
  const now = new Date()
  return app.withTenant(tenantId, async () => {
    const rows = await app.db.select({ id: pbxExtensions.id }).from(pbxExtensions)
    let updated = 0
    for (const row of rows) {
      const state = byId.get(row.id)
      await app.db
        .update(pbxExtensions)
        .set(
          state
            ? {
                regStatus: state.status,
                regExpiresAt: state.expiresAt,
                lastError: state.status === 'failed' ? `The phone system reported ${state.detail}.` : null,
                updatedAt: now,
              }
            : {
                regStatus: 'unregistered' as const,
                regExpiresAt: null,
                lastError: 'The bridge is not attempting this registration — republish the extension map.',
                updatedAt: now,
              },
        )
        .where(eq(pbxExtensions.id, row.id))
      updated += 1
    }
    return { ok: true, detail: `Registration state read for ${updated} extension${updated === 1 ? '' : 's'}.`, updated }
  })
}

/** Assign (or clear, with null) an agent's phone-system extension. Extensions
 *  are short dialable codes, unique per tenant. */
export async function assignExtension(args: {
  tenantId: string
  personId: string
  extension: string | null
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const app = db()
  const extension = args.extension?.trim() || null
  if (extension && !/^[0-9]{2,6}$/.test(extension)) {
    return { ok: false, message: 'An extension is 2–6 digits, e.g. 701.' }
  }
  return app.withTenant(args.tenantId, async () => {
    if (extension) {
      const [taken] = await app.db
        .select({ id: people.id, name: people.name })
        .from(people)
        .where(and(eq(people.extension, extension), ne(people.id, args.personId)))
      if (taken) {
        return { ok: false as const, message: `Extension ${extension} is already assigned to ${taken.name}.` }
      }
    }
    await app.db
      .update(people)
      .set({ extension, updatedAt: new Date() })
      .where(eq(people.id, args.personId))
    return { ok: true as const }
  })
}

// ---------------------------------------------------------------------------
// Phone numbers — the carrier path
// ---------------------------------------------------------------------------

export type PhoneNumberRow = typeof phoneNumbers.$inferSelect

/** Bare E.164 digits, or null when the input cannot be a phone number. */
export function normalizePhoneNumber(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, '')
  return digits.length >= 7 && digits.length <= 15 ? digits : null
}

export async function listPhoneNumbers(
  tenantId: string,
): Promise<(PhoneNumberRow & { personName: string })[]> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const rows = await app.db
      .select({ row: phoneNumbers, personName: people.name })
      .from(phoneNumbers)
      .innerJoin(people, eq(people.id, phoneNumbers.personId))
    return rows.map((r) => ({ ...r.row, personName: r.personName }))
  })
}

/** Point a number at an agent — one row per number, upserted. */
export async function assignPhoneNumber(args: {
  tenantId: string
  number: string
  label: string
  personId: string
  /** The line this number arrives on and leaves by, when it is known. */
  trunkId?: string | null
  provider?: 'manual' | 'twilio'
  providerSid?: string | null
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const digits = normalizePhoneNumber(args.number)
  if (!digits) return { ok: false, message: 'Enter the number with country code, e.g. +1 555 123 4567.' }
  if (!args.label.trim()) return { ok: false, message: 'Give the number a label.' }
  const app = db()
  return app.withTenant(args.tenantId, async () => {
    const [agent] = await app.db
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.id, args.personId), eq(people.kind, 'agent'), eq(people.status, 'active')))
    if (!agent) return { ok: false as const, message: 'Pick an active agent to answer this number.' }
    const carrier = {
      trunkId: args.trunkId ?? null,
      provider: args.provider ?? 'manual',
      providerSid: args.providerSid ?? null,
    }
    await app.db
      .insert(phoneNumbers)
      .values({
        tenantId: args.tenantId,
        number: digits,
        label: args.label.trim(),
        personId: args.personId,
        ...carrier,
      })
      .onConflictDoUpdate({
        target: [phoneNumbers.tenantId, phoneNumbers.number],
        set: { label: args.label.trim(), personId: args.personId, ...carrier, updatedAt: new Date() },
      })
    return { ok: true as const }
  })
}

/**
 * The number an agent should present when it dials out on a given line. A
 * carrier only connects a call whose From is a number the account holds, so
 * this is the agent's own provisioned number — the one whoever they called can
 * ring back — and failing that whatever default the line carries.
 */
export async function outboundCallerId(args: {
  tenantId: string
  personId: string
  trunkId: string
}): Promise<string | null> {
  const app = db()
  const rows = await app.withTenantContext(args.tenantId, () =>
    app.db
      .select({ number: phoneNumbers.number, trunkId: phoneNumbers.trunkId })
      .from(phoneNumbers)
      .where(eq(phoneNumbers.personId, args.personId)),
  )
  // A number known to be on this line wins; one with no line recorded predates
  // the carrier path and is still the agent's own, so it is the next best thing.
  const onTrunk = rows.find((row) => row.trunkId === args.trunkId)
  const unattached = rows.find((row) => row.trunkId === null)
  return onTrunk?.number ?? unattached?.number ?? null
}

export async function removePhoneNumber(tenantId: string, numberId: string): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db.delete(phoneNumbers).where(eq(phoneNumbers.id, numberId))
  })
}
