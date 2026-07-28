import 'server-only'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { SipClient, type CreateSipOutboundTrunkOptions } from 'livekit-server-sdk'
import { unsealSecret } from '@appkit/crypto'
import { defineAbility, type Ability } from '@bunkhouse/runtime'
import { callSessions, people } from '../db/schema'
import { db } from '../db/client'
import { listSipTrunks, type SipTrunkRow } from './pbx'

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

// livekit.SIPTransport wire values (AUTO 0, UDP 1, TCP 2, TLS 3). The generated
// enum lives in @livekit/protocol — a transitive dependency of the server SDK
// that this package does not resolve — so the values are named here.
const SIP_TRANSPORT: Record<SipTrunkRow['transport'], SipTransportValue> = {
  udp: 1 as SipTransportValue,
  tcp: 2 as SipTransportValue,
  tls: 3 as SipTransportValue,
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
 * The trunk the tenant dials out on. 'extension' mode is the registered-endpoint
 * bridge, which does not originate calls yet; a trunk with no PBX/carrier
 * address has nowhere to send an INVITE.
 */
async function selectOutboundTrunk(tenantId: string): Promise<SipTrunkRow | null> {
  const trunks = await listSipTrunks(tenantId)
  const usable = trunks.filter((trunk) => trunk.mode === 'trunk' && Boolean(trunk.pbxHost))
  return usable.find((trunk) => trunk.status === 'active') ?? usable[0] ?? null
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
  const mine = (await client.listSipOutboundTrunk()).filter((existing) => existing.name === name)
  const match = mine.find((existing) => existing.address === address && existing.transport === transport)
  for (const stale of mine) {
    if (stale.sipTrunkId === match?.sipTrunkId) continue
    await client.deleteSipTrunk(stale.sipTrunkId).catch(() => undefined)
  }
  if (match) return match.sipTrunkId
  const password = trunk.sealedAuthPassword ? unsealSecret(trunk.sealedAuthPassword) : null
  const created = await client.createSipOutboundTrunk(name, address, [], {
    transport,
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

  const env = livekitEnv()
  if (!env) {
    return { placed: false, reason: 'The phone system is not connected on this deployment. Say plainly that you cannot make calls right now.' }
  }
  const trunk = await selectOutboundTrunk(tenantId)
  if (!trunk) {
    return {
      placed: false,
      reason: 'No outbound phone line is configured for the company, so there is nothing to dial through. Tell whoever asked that calling has not been set up yet, and offer to email instead.',
    }
  }

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
      purpose,
    })
  })

  try {
    await client.createSipParticipant(livekitTrunkId, target.number, room, {
      participantName: args.to.trim(),
      participantAttributes: { 'bunkhouse.tenantId': tenantId, 'bunkhouse.sessionId': sessionId },
      // The caller id desk phones show: the agent's own extension when it has
      // one, otherwise whatever the trunk presents.
      ...(person.extension ? { fromNumber: person.extension } : {}),
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
  const trunk = await selectOutboundTrunk(args.tenantId)
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
