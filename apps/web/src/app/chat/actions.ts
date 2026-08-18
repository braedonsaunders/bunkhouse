'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { mintLiveKitToken } from '@braedonsaunders/appkit-voice'
import { ParticipantKind } from '@livekit/rtc-node'
import { RoomServiceClient } from 'livekit-server-sdk'
import type { ChatRequester } from '@bunkhouse/runtime'
import { requireTenantPermission, type TenantAccess } from '../../lib/tenant'
import {
  getThread,
  listThreads,
  renameThread,
  sendMessage,
  setThreadStatus,
  startThread,
  type ChatMessageView,
  type ChatThreadStatus,
  type ChatThreadSummary,
  type ChatThreadView,
} from '../../lib/chat-threads'
import {
  closeDesktop,
  deskStatus,
  openDesktop,
  parseDeskInput,
  sendDesktopInput,
  setDeskFrameRate,
  setTakeover,
  type ChatDeskStatus,
} from '../../lib/chat-desk'
import { chatWorkSurface, type ChatWorkSurface } from '../../lib/chat-work-surface'
import { runScreenRoomName } from '../../lib/run-screen-room'
import { observeRemoteWork } from '../../lib/remote-computers'

/**
 * The chat page's server actions.
 *
 * Two families, one rule each:
 *
 *   · The conversation. Reading is `work.read`; saying something is
 *     `work.manage`, because saying something to an agent IS starting work —
 *     the message becomes a governed run (lib/chat-threads.ts), and there is
 *     no second loop it could go through instead.
 *   · The desk. Every one of these is `work.manage` and then passes the desk's
 *     own gates — runner configured, agent live in this tenant, the `desk`
 *     feature, the `desktop` feature, and the agent's autonomy dial for
 *     `desktop` — enforced in lib/chat-desk.ts, which is where they are
 *     written down once. A person driving an agent's screen through this page
 *     is governed exactly like the agent driving it itself.
 *
 * Everything returns rather than throws where the answer is an ordinary "no":
 * the page shows the sentence in place instead of dropping the operator on an
 * error screen with their message gone.
 */

const CHAT_PATH = '/chat'

function chatRequesterFor(access: TenantAccess): ChatRequester {
  return {
    name: access.user.name.trim() || access.user.email,
    email: access.user.email,
    relationship: 'operator',
  }
}

export async function listThreadsAction(
  options?: { includeArchived?: boolean; personId?: string },
): Promise<ChatThreadSummary[]> {
  const access = await requireTenantPermission('work.read')
  return listThreads({
    tenantId: access.tenantId,
    userId: access.user.id,
    includeArchived: options?.includeArchived === true,
    ...(options?.personId ? { personId: options.personId } : {}),
  })
}

export async function getThreadAction(
  threadId: string,
): Promise<{ thread: ChatThreadView; messages: ChatMessageView[] } | null> {
  if (!threadId) return null
  const access = await requireTenantPermission('work.read')
  return getThread(access.tenantId, threadId)
}

/** The visual stage plus durable step history for the conversation. */
export async function workSurfaceAction(threadId: string): Promise<ChatWorkSurface> {
  const access = await requireTenantPermission('work.read')
  if (!threadId) return { kind: 'idle', runId: null, history: [], remote: null }
  return chatWorkSurface(access.tenantId, threadId)
}

/** Exchange an authenticated observation lease for a short-lived provider viewer URL. */
export async function observeRemoteWorkSurfaceAction(input: {
  threadId: string
  sessionId: string
}): Promise<{ url: string; expiresAt: string }> {
  const access = await requireTenantPermission('work.read')
  const current = await chatWorkSurface(access.tenantId, input.threadId)
  if (!current.remote || current.remote.sessionId !== input.sessionId) {
    throw new Error('That remote computer session is no longer active in this conversation.')
  }
  return observeRemoteWork({ tenantId: access.tenantId, sessionId: input.sessionId, holder: `operator:${access.user.id}` })
}

/** A subscribe-only LiveKit credential for the active browser or call stage. */
export async function observeWorkSurfaceAction(input: {
  threadId: string
  runId: string
  kind: 'browser' | 'call'
  sessionId?: string
}): Promise<{ serverUrl: string; token: string }> {
  const access = await requireTenantPermission('work.read')
  const current = await chatWorkSurface(access.tenantId, input.threadId)
  if (current.runId !== input.runId || current.kind !== input.kind) {
    throw new Error('That live work surface is no longer active.')
  }

  const serverUrl = process.env.LIVEKIT_URL
  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET
  if (!serverUrl || !apiKey || !apiSecret) {
    throw new Error('Live screen viewing is not available in this deployment.')
  }

  let room: string
  if (current.kind === 'call') {
    if (!input.sessionId || input.sessionId !== current.sessionId) {
      throw new Error('That call is no longer active.')
    }
    room = current.room
    // A standard observer that arrives before the voice worker could be
    // selected as the call's human input participant. Wait until LiveKit has
    // the agent participant on the room; the client retries this short-lived
    // state while the stage says it is still connecting.
    const participants = await new RoomServiceClient(serverUrl, apiKey, apiSecret)
      .listParticipants(room)
      .catch(() => [])
    if (!participants.some((participant) => Number(participant.kind) === ParticipantKind.AGENT)) {
      throw new Error('The live stage is waiting for the agent to join.')
    }
  } else {
    room = runScreenRoomName(current.runId)
  }

  const token = await mintLiveKitToken(
    { apiKey, apiSecret },
    {
      identity: `observer:${access.user.id}:${randomUUID()}`,
      name: access.user.name ?? 'Observer',
      room,
      metadata: JSON.stringify({ tenantId: access.tenantId, runId: current.runId, kind: 'work-observer' }),
      canPublish: false,
      canSubscribe: true,
      ttlSeconds: 60 * 60,
    },
  )
  return { serverUrl, token }
}

/**
 * Open a conversation with an agent.
 *
 * With an opening message, the first turn is taken here — same path as every
 * later turn, so the run, the ledger and the dial are identical. A caller that
 * streams the first turn instead (POST /api/chat/[threadId]) passes an empty
 * body and gets back an empty thread to stream into; the turn still happens
 * exactly once, through exactly one implementation.
 */
export async function startThreadAction(personId: string, body: string): Promise<{ threadId: string }> {
  const access = await requireTenantPermission('work.manage')
  const opening = body?.trim() ?? ''
  const { threadId } = await startThread({
    tenantId: access.tenantId,
    userId: access.user.id,
    personId,
    ...(opening ? { firstMessage: opening } : {}),
  })
  if (opening) {
    await sendMessage({
      tenantId: access.tenantId,
      threadId,
      userId: access.user.id,
      body: opening,
      requester: chatRequesterFor(access),
    })
  }
  revalidatePath(CHAT_PATH)
  return { threadId }
}

/**
 * Say something, and get the answer. The non-streaming path; the streaming
 * route shares the same implementation and differs only in how it reports
 * progress.
 */
export async function sendMessageAction(
  threadId: string,
  body: string,
): Promise<{ messages: ChatMessageView[] }> {
  const access = await requireTenantPermission('work.manage')
  const result = await sendMessage({
    tenantId: access.tenantId,
    threadId,
    userId: access.user.id,
    body,
    requester: chatRequesterFor(access),
  })
  revalidatePath(CHAT_PATH)
  return result
}

// ---------------------------------------------------------------------------
// Keeping the list — naming a conversation, and putting one away
// ---------------------------------------------------------------------------

/**
 * Both of these change a governed record, so both are `work.manage` — the same
 * permission saying something in the thread needs, because a conversation
 * someone may not post into is not one they may rename or file away either.
 *
 * Ownership on top of that is `lib/chat-threads.ts`'s: the thread is re-read
 * there and refused unless it belongs to the caller. Neither of these actions
 * trusts the id it is handed for anything but the lookup.
 *
 * There is deliberately no delete. A thread is a view onto runs and its
 * messages carry the run ids that did the work; archiving takes it out of the
 * list, which is what was actually wanted, without erasing the record.
 */
export async function renameThreadAction(
  threadId: string,
  title: string,
): Promise<{ ok: true; title: string } | { error: string }> {
  const access = await requireTenantPermission('work.manage')
  if (!threadId) return { error: 'No conversation was named.' }
  try {
    const { title: named } = await renameThread({
      tenantId: access.tenantId,
      threadId,
      userId: access.user.id,
      title,
    })
    revalidatePath(CHAT_PATH)
    return { ok: true, title: named }
  } catch (reason) {
    // A blank name, an over-long one, somebody else's conversation: ordinary
    // answers of "no" that belong beside the list, not on an error screen.
    return { error: reason instanceof Error ? reason.message : 'That conversation could not be renamed.' }
  }
}

export async function setThreadStatusAction(
  threadId: string,
  status: ChatThreadStatus,
): Promise<{ ok: true; status: ChatThreadStatus } | { error: string }> {
  const access = await requireTenantPermission('work.manage')
  if (!threadId) return { error: 'No conversation was named.' }
  // A server action is a public endpoint: the type says `open | closed`, the
  // caller is whatever posted to it.
  if (status !== 'open' && status !== 'closed') return { error: 'That is not something a conversation can be.' }
  try {
    await setThreadStatus({ tenantId: access.tenantId, threadId, userId: access.user.id, status })
    revalidatePath(CHAT_PATH)
    return { ok: true, status }
  } catch (reason) {
    return { error: reason instanceof Error ? reason.message : 'That conversation could not be changed.' }
  }
}

// ---------------------------------------------------------------------------
// The desk
// ---------------------------------------------------------------------------

/** Who is at the controls, for the record. */
function actorFor(access: TenantAccess): { name: string } {
  return { name: access.user.name.trim() || access.user.email }
}

export async function deskStatusAction(personId: string): Promise<ChatDeskStatus> {
  const access = await requireTenantPermission('work.read')
  if (!personId) {
    return { supported: false, desk: false, desktop: false, screenRunning: false, reason: 'No agent selected.' }
  }
  return deskStatus({ tenantId: access.tenantId, personId })
}

/**
 * Open the agent's screen for the operator. The reason is optional and stays a
 * second argument so any caller that has one — a handover, a scripted step —
 * still records it; the console itself has none to give, and openDesktop
 * writes who opened it instead (see lib/chat-desk.ts).
 */
export async function openDesktopAction(
  personId: string,
  reason?: string,
): Promise<{ ok: true } | { error: string }> {
  const access = await requireTenantPermission('work.manage')
  if (!personId) return { error: 'No agent selected.' }
  return openDesktop({
    tenantId: access.tenantId,
    personId,
    actor: actorFor(access),
    ...(reason?.trim() ? { reason } : {}),
  })
}

export async function closeDesktopAction(personId: string): Promise<{ ok: true } | { error: string }> {
  const access = await requireTenantPermission('work.manage')
  if (!personId) return { error: 'No agent selected.' }
  return closeDesktop({ tenantId: access.tenantId, personId, actor: actorFor(access) })
}

/**
 * Take the screen, or hand it back. While a takeover is live nothing the
 * person does is recorded and no frame leaves the guest — only that it
 * happened, who took it, and for how long (§3.14). `url` is the runner's own
 * TTL-bounded viewer for the handover.
 */
export async function takeoverAction(
  personId: string,
  enabled: boolean,
): Promise<{ ok: true; active: boolean; url?: string } | { error: string }> {
  const access = await requireTenantPermission('work.manage')
  if (!personId) return { error: 'No agent selected.' }
  return setTakeover({ tenantId: access.tenantId, personId, actor: actorFor(access), enabled })
}

/**
 * How fast the desk's live capture should run: fast while the operator is
 * driving, slow while they are only watching. It re-tunes the capture that is
 * already running rather than opening anything, so the picture on screen never
 * drops out when the mode changes.
 *
 * `work.manage` like the rest of the desk family, and gated by lib/chat-desk.ts
 * exactly the same way — asking a machine to paint faster is asking something
 * of that machine.
 */
export async function setDeskFrameRateAction(
  personId: string,
  driving: boolean,
): Promise<{ ok: true; fps: number; streaming: boolean } | { error: string }> {
  const access = await requireTenantPermission('work.manage')
  if (!personId) return { error: 'No agent selected.' }
  return setDeskFrameRate({ tenantId: access.tenantId, personId, driving })
}

/** One input on the agent's screen, in the desk-v1 shape. */
export async function sendDesktopInputAction(
  personId: string,
  action: unknown,
): Promise<{ ok: true } | { error: string }> {
  const access = await requireTenantPermission('work.manage')
  if (!personId) return { error: 'No agent selected.' }
  const parsed = parseDeskInput(action)
  if (!parsed) return { error: 'That is not something the screen can be asked to do.' }
  return sendDesktopInput({
    tenantId: access.tenantId,
    personId,
    actor: actorFor(access),
    action: parsed,
  })
}
