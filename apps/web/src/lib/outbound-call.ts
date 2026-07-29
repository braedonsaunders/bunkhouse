import 'server-only'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { RoomServiceClient, SipClient, type CreateSipOutboundTrunkOptions } from 'livekit-server-sdk'
import { unsealSecret } from '@appkit/crypto'
import { defineAbility, type Ability } from '@bunkhouse/runtime'
import { callSessions, people } from '../db/schema'
import { db } from '../db/client'
import { listSipTrunks, outboundCallerId, type SipTrunkRow } from './pbx'
import { callMinutesBudget, nextMonthPhrase } from './call-budget'

/**
 * Outbound telephony: the agent dials out. `place_call` creates the call
 * session first, then asks LiveKit SIP to dial the callee into that room over
 * the tenant's trunk; the voice worker is dispatched into the room and holds
 * the conversation from the briefing stored on the session. The call is
 * recorded under the run that placed it — dialing someone is part of the work
 * in hand, not a new errand.
 *
 * `transfer_call` lives next to it because it shares the trunk resolution:
 * handing a live caller to a human is a SIP REFER over the same trunk.
 */

type PersonRow = typeof people.$inferSelect

/** Rooms the voice worker answers as agent-placed calls. */
export const OUTBOUND_ROOM_PREFIX = 'out-'

export function outboundRoomName(sessionId: string): string {
  return `${OUTBOUND_ROOM_PREFIX}${sessionId}`
}

/** The LiveKit outbound trunk mirrored from one sip_trunks row. */
function outboundTrunkName(trunkId: string): string {
  return `bunkhouse-out-${trunkId}`
}

type SipTransportValue = CreateSipOutboundTrunkOptions['transport']
type SipMediaEncryptionValue = NonNullable<CreateSipOutboundTrunkOptions['mediaEncryption']>

// livekit.SIPTransport wire values (AUTO 0, UDP 1, TCP 2, TLS 3). The generated
// enum lives in @livekit/protocol — a transitive dependency of the server SDK
// that this package does not resolve — so the values are named here.
const SIP_TRANSPORT: Record<SipTrunkRow['transport'], SipTransportValue> = {
  udp: 1 as SipTransportValue,
  tcp: 2 as SipTransportValue,
  tls: 3 as SipTransportValue,
}

// livekit.SIPMediaEncryption wire values (DISABLE 0, ALLOW 1, REQUIRE 2),
// named here for the same reason.
const SIP_MEDIA_ENCRYPTION: Record<SipTrunkRow['srtp'], SipMediaEncryptionValue> = {
  disabled: 0 as SipMediaEncryptionValue,
  best_effort: 1 as SipMediaEncryptionValue,
  required: 2 as SipMediaEncryptionValue,
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

export type DialTarget = { kind: 'extension' | 'e164'; number: string }

/**
 * What the agent typed, as something dialable: a short internal extension, or
 * an E.164 number. Anything else is not a phone destination.
 */
export function parseDialTarget(raw: string): DialTarget | null {
  const trimmed = raw.trim()
  const digits = trimmed.replace(/[^0-9]/g, '')
  if (!digits) return null
  if (!trimmed.startsWith('+') && /^[0-9]{2,6}$/.test(digits)) return { kind: 'extension', number: digits }
  if (digits.length >= 7 && digits.length <= 15) return { kind: 'e164', number: `+${digits}` }
  return null
}

/**
 * The trunk the tenant dials out on, for the kind of destination in hand.
 * 'extension' mode is the registered-endpoint bridge, which does not originate
 * calls yet; a trunk with no PBX/carrier address has nowhere to send an INVITE.
 *
 * A company with both a phone system and a carrier has one line for each, so
 * the destination decides: a line that says it carries this kind is preferred
 * over one that carries everything, and only then is an active line preferred
 * over an idle one. Without that ordering an internal extension can leave over
 * the carrier — where it means nothing — and a real number can be handed to a
 * PBX with no route for it.
 */
async function selectOutboundTrunk(tenantId: string, kind: DialTarget['kind']): Promise<SipTrunkRow | null> {
  const trunks = await listSipTrunks(tenantId)
  const usable = trunks.filter((trunk) => trunk.mode === 'trunk' && Boolean(trunk.pbxHost))
  const wanted = kind === 'extension' ? 'internal' : 'external'
  const ordered = [
    ...usable.filter((trunk) => trunk.dialScope === wanted),
    ...usable.filter((trunk) => trunk.dialScope === 'both'),
  ]
  return ordered.find((trunk) => trunk.status === 'active') ?? ordered[0] ?? null
}

/**
 * The caller id to present. On the company's own phone system that is the
 * agent's extension, which is what a desk phone can call back. Off it, the
 * extension means nothing and a carrier will refuse a From it does not own —
 * so it is the agent's provisioned number, or the line's default, and if
 * neither exists the call is not attempted at all. A rejected INVITE explains
 * itself far worse than this does.
 */
async function resolveCallerId(args: {
  tenantId: string
  person: PersonRow
  trunk: SipTrunkRow
  kind: DialTarget['kind']
}): Promise<{ ok: true; fromNumber: string | null } | { ok: false; reason: string }> {
  if (args.kind === 'extension') return { ok: true, fromNumber: args.person.extension }
  const own = await outboundCallerId({ tenantId: args.tenantId, personId: args.person.id, trunkId: args.trunk.id })
  const presented = own ?? args.trunk.callerId
  if (presented) return { ok: true, fromNumber: `+${presented}` }
  if (args.trunk.flavor === 'twilio_sip') {
    return {
      ok: false,
      reason:
        'You have no phone number of your own, and the company line has no default caller id, so the carrier would refuse the call. Tell whoever asked that a number needs assigning to you in Settings → Phone system → Numbers, and offer to email in the meantime.',
    }
  }
  // A PBX breaking out to the public network presents whatever its own trunk
  // is configured to, which is the operator's business and not ours.
  return { ok: true, fromNumber: args.person.extension }
}

/**
 * The LiveKit outbound trunk for a sip_trunks row, reused when it already
 * matches the row and rebuilt when it does not — the same reconstruct-on-save
 * idempotence the inbound mirror uses, keyed by name because outbound trunk ids
 * have no column of their own on the row.
 */
async function ensureOutboundTrunk(client: SipClient, tenantId: string, trunk: SipTrunkRow): Promise<string> {
  const name = outboundTrunkName(trunk.id)
  const address = `${trunk.pbxHost}:${trunk.pbxPort}`
  const transport = SIP_TRANSPORT[trunk.transport]
  const mediaEncryption = SIP_MEDIA_ENCRYPTION[trunk.srtp]
  const mine = (await client.listSipOutboundTrunk()).filter((existing) => existing.name === name)
  const match = mine.find(
    (existing) =>
      existing.address === address &&
      existing.transport === transport &&
      existing.mediaEncryption === mediaEncryption,
  )
  for (const stale of mine) {
    if (stale.sipTrunkId === match?.sipTrunkId) continue
    await client.deleteSipTrunk(stale.sipTrunkId).catch(() => undefined)
  }
  if (match) return match.sipTrunkId
  const password = trunk.sealedAuthPassword ? unsealSecret(trunk.sealedAuthPassword) : null
  const created = await client.createSipOutboundTrunk(name, address, [], {
    transport,
    mediaEncryption,
    ...(trunk.authUsername ? { authUsername: trunk.authUsername } : {}),
    ...(password ? { authPassword: password } : {}),
    metadata: JSON.stringify({ tenantId, trunkId: trunk.id }),
  })
  return created.sipTrunkId
}

export type PlaceCallResult =
  | { placed: true; sessionId: string; room: string; dialed: string; note: string }
  | { placed: false; reason: string }

/**
 * Dial someone. The session row is committed before the INVITE goes out so the
 * voice worker — dispatched the moment LiveKit creates the room — always finds
 * the call it is joining, briefing and all.
 */
export async function placeOutboundCall(args: {
  tenantId: string
  person: PersonRow
  runId: string
  to: string
  reason: string
}): Promise<PlaceCallResult> {
  const { tenantId, person, runId } = args
  const purpose = args.reason.trim()
  if (!purpose) {
    return { placed: false, reason: 'Say what the call is for — the briefing is what you open the conversation with.' }
  }
  const target = parseDialTarget(args.to)
  if (!target) {
    return {
      placed: false,
      reason: `"${args.to}" is not a number you can dial. Use an internal extension (2–6 digits) or a full number with country code, e.g. +15551234567.`,
    }
  }
  if (!person.voiceConfig) {
    return {
      placed: false,
      reason: 'You have no voice configured, so you cannot speak on a call. Tell whoever asked that this needs setting up on your profile first.',
    }
  }

  // Call minutes are part of salary. Once the month's ceiling is reached the
  // agent stops dialing until it resets — the work still gets done, in writing.
  const budget = await callMinutesBudget({ tenantId, personId: person.id, salary: person.salary })
  if (budget.exhausted) {
    return {
      placed: false,
      reason: `You have used all ${budget.limitMinutes} of your call minutes for this month, so you cannot place calls until ${nextMonthPhrase()}. Say so plainly and deal with this by email instead.`,
    }
  }

  const env = livekitEnv()
  if (!env) {
    return { placed: false, reason: 'The phone system is not connected on this deployment. Say plainly that you cannot make calls right now.' }
  }
  const trunk = await selectOutboundTrunk(tenantId, target.kind)
  if (!trunk) {
    return {
      placed: false,
      reason:
        target.kind === 'extension'
          ? 'No line to the company phone system is configured, so internal extensions cannot be dialed. Tell whoever asked, and reach them another way.'
          : 'No outbound phone line is configured for the company, so there is nothing to dial through. Tell whoever asked that calling has not been set up yet, and offer to email instead.',
    }
  }
  const callerId = await resolveCallerId({ tenantId, person, trunk, kind: target.kind })
  if (!callerId.ok) return { placed: false, reason: callerId.reason }

  const client = new SipClient(env.host, env.apiKey, env.apiSecret)
  let livekitTrunkId: string
  try {
    livekitTrunkId = await ensureOutboundTrunk(client, tenantId, trunk)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { placed: false, reason: `The phone line "${trunk.name}" could not be prepared for dialing: ${message}` }
  }

  const app = db()
  const sessionId = randomUUID()
  const room = outboundRoomName(sessionId)
  await app.withTenant(tenantId, async () => {
    await app.db.insert(callSessions).values({
      id: sessionId,
      tenantId,
      personId: person.id,
      runId,
      room,
      direction: 'outbound_phone',
      counterparty: { name: args.to.trim(), number: target.number },
      // An internal extension is a call onto the company phone system; a full
      // number leaves for the public network.
      peerKind: target.kind === 'extension' ? 'pbx_extension' : 'pstn',
      ...(target.kind === 'extension' ? { peerExtension: target.number } : {}),
      purpose,
    })
  })

  try {
    await client.createSipParticipant(livekitTrunkId, target.number, room, {
      participantName: args.to.trim(),
      participantAttributes: { 'bunkhouse.tenantId': tenantId, 'bunkhouse.sessionId': sessionId },
      // What the person being called sees: the agent's extension on the
      // company's own system, its provisioned number off it.
      ...(callerId.fromNumber ? { fromNumber: callerId.fromNumber } : {}),
      ringingTimeout: 45,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const now = new Date()
    await app.withTenant(tenantId, async () => {
      await app.db
        .update(callSessions)
        .set({ status: 'failed', endedAt: now, durationSeconds: 0, updatedAt: now })
        .where(eq(callSessions.id, sessionId))
    })
    return { placed: false, reason: `The call to ${args.to.trim()} could not be connected: ${message}` }
  }

  return {
    placed: true,
    sessionId,
    room,
    dialed: target.number,
    note: `${target.number} is ringing. You will be on that call yourself once it is answered, and it is logged here either way — there is nothing more to do about it now.`,
  }
}

/** The dial-out ability, governed by the phone_call autonomy category. */
export function outboundCallAbilities(args: { tenantId: string; person: PersonRow; runId: string }): Ability[] {
  return [
    defineAbility({
      name: 'place_call',
      description:
        'Call someone on the telephone — an internal extension on the company phone system, or an outside number in full international form. Use it when a conversation is genuinely faster than writing, and only when you know what you want to say. You hold the call yourself once it connects.',
      category: 'phone_call',
      inputSchema: z.object({
        to: z
          .string()
          .describe('An internal extension (2–6 digits, e.g. 701) or a full number with country code, e.g. +15551234567'),
        reason: z
          .string()
          .describe('What the call is for, in a sentence — this is the briefing you open the conversation with.'),
      }),
      execute: async ({ to, reason }) =>
        placeOutboundCall({ tenantId: args.tenantId, person: args.person, runId: args.runId, to, reason }),
    }),
  ]
}

// ---------------------------------------------------------------------------
// Test call — proving a line before anyone depends on it
// ---------------------------------------------------------------------------

/** Rooms a test call uses. Deliberately not a call-room prefix: the voice
 *  agent leaves these alone, so nothing answers and nothing is billed. */
const TEST_ROOM_PREFIX = 'siptest-'

export type TestCallStep = { label: string; detail: string; ok: boolean }

export type TestCallResult = {
  ok: boolean
  /** The SIP exchange as it actually went, step by step. */
  steps: TestCallStep[]
  summary: string
}

/** The SIP status a failure carries, when the far end sent one. */
function sipStatusFrom(message: string): string | null {
  const match = /\b([1-6][0-9]{2})\b\s*([A-Za-z][A-Za-z ]{2,40})?/.exec(message)
  if (!match) return null
  const reason = match[2]?.trim()
  return reason ? `${match[1]} ${reason}` : match[1]!
}

/**
 * Dial a test extension over a trunk and report what the phone system said.
 *
 * This is a real INVITE over the real trunk — the only honest test of a SIP
 * line. The call is hung up the moment it is answered: the point is the
 * response chain, not a conversation. Nothing is written to the call ledger,
 * because no agent held a conversation.
 */
export async function placeTestCall(args: {
  tenantId: string
  trunkId: string
  extension: string
}): Promise<TestCallResult> {
  const steps: TestCallStep[] = []
  const fail = (summary: string): TestCallResult => ({ ok: false, steps, summary })

  const target = parseDialTarget(args.extension)
  if (!target) {
    return fail(`"${args.extension}" is not a number this phone system can be asked to dial.`)
  }
  const env = livekitEnv()
  if (!env) return fail('The phone system is not connected on this deployment.')

  const trunks = await listSipTrunks(args.tenantId)
  const trunk = trunks.find((entry) => entry.id === args.trunkId)
  if (!trunk) return fail('This trunk no longer exists.')
  if (trunk.mode !== 'trunk') {
    return fail(
      `"${trunk.name}" reaches the phone system by registering extensions, so there is no line to place a test call over. Check the registration state on the Extensions tab instead.`,
    )
  }
  if (!trunk.pbxHost) return fail(`"${trunk.name}" has no phone system address, so there is nowhere to send the call.`)

  const client = new SipClient(env.host, env.apiKey, env.apiSecret)
  let livekitTrunkId: string
  try {
    livekitTrunkId = await ensureOutboundTrunk(client, args.tenantId, trunk)
    steps.push({
      label: 'Line prepared',
      detail: `${trunk.pbxHost}:${trunk.pbxPort} over ${trunk.transport.toUpperCase()}${
        trunk.srtp === 'disabled' ? '' : `, media encryption ${trunk.srtp === 'required' ? 'required' : 'best effort'}`
      }.`,
      ok: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    steps.push({ label: 'Line prepared', detail: message, ok: false })
    return fail(`The line could not be prepared for dialing: ${message}`)
  }

  const room = `${TEST_ROOM_PREFIX}${randomUUID()}`
  const dialed = target.number
  try {
    const participant = await client.createSipParticipant(livekitTrunkId, dialed, room, {
      participantIdentity: 'bunkhouse-test',
      participantName: 'Phone system test',
      waitUntilAnswered: true,
      ringingTimeout: 20,
      maxCallDuration: 10,
    })
    steps.push({ label: `INVITE to ${dialed}`, detail: 'Sent over the trunk.', ok: true })
    steps.push({
      label: '200 OK — answered',
      detail: `The phone system connected the call${participant.sipCallId ? ` (call id ${participant.sipCallId})` : ''}.`,
      ok: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = sipStatusFrom(message)
    steps.push({ label: `INVITE to ${dialed}`, detail: 'Sent over the trunk.', ok: true })
    steps.push({
      label: status ? `Rejected — ${status}` : 'No answer',
      detail: message,
      ok: false,
    })
    return fail(
      status
        ? `${dialed} was not connected: the phone system answered ${status}.`
        : `${dialed} was not connected: ${message}`,
    )
  }

  // Hang up: the room is the call, so deleting it clears the line.
  try {
    const rooms = new RoomServiceClient(env.host, env.apiKey, env.apiSecret)
    await rooms.deleteRoom(room)
    steps.push({ label: 'Hung up', detail: 'The test call was cleared.', ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    steps.push({
      label: 'Hung up',
      detail: `The call connected, but clearing it reported: ${message}`,
      ok: false,
    })
  }

  return {
    ok: true,
    steps,
    summary: `${dialed} answered over "${trunk.name}". The line carries calls in both directions.`,
  }
}

export type TransferCallResult =
  | { transferred: true; target: string }
  | { transferred: false; reason: string }

/**
 * Hand the person on the line to a human: a SIP REFER toward their extension
 * over the tenant's trunk. Cold transfer — once the PBX takes it the agent is
 * out of the conversation, so the agent says goodbye before calling this.
 */
export async function transferCallToExtension(args: {
  tenantId: string
  room: string
  participantIdentity: string
  extension: string
}): Promise<TransferCallResult> {
  const target = parseDialTarget(args.extension)
  if (!target) {
    return {
      transferred: false,
      reason: `"${args.extension}" is not a number you can transfer to. Use a colleague's extension, or a full number with country code.`,
    }
  }
  const env = livekitEnv()
  if (!env) {
    return { transferred: false, reason: 'The phone system is not connected on this deployment, so the call cannot be transferred.' }
  }
  const trunk = await selectOutboundTrunk(args.tenantId, target.kind)
  // An extension is addressed at the PBX explicitly — its dial plan is what
  // resolves the digits. A real number goes as a tel: URI, which LiveKit routes
  // over the trunk the call already came in on.
  const transferTo =
    target.kind === 'extension' && trunk?.pbxHost
      ? `sip:${target.number}@${trunk.pbxHost}:${trunk.pbxPort}`
      : `tel:${target.number}`
  const client = new SipClient(env.host, env.apiKey, env.apiSecret)
  try {
    await client.transferSipParticipant(args.room, args.participantIdentity, transferTo, {
      // Ringback while the destination is reached, so the line is not silent.
      playDialtone: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { transferred: false, reason: message }
  }
  return { transferred: true, target: transferTo }
}
