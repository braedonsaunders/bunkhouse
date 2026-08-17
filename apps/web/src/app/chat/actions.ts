'use server'

import { revalidatePath } from 'next/cache'
import { requireTenantPermission, type TenantAccess } from '../../lib/tenant'
import {
  getThread,
  listThreads,
  sendMessage,
  startThread,
  type ChatMessageView,
  type ChatThreadSummary,
  type ChatThreadView,
} from '../../lib/chat-threads'
import {
  closeDesktop,
  deskStatus,
  openDesktop,
  parseDeskInput,
  sendDesktopInput,
  setTakeover,
  type ChatDeskStatus,
} from '../../lib/chat-desk'

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

export async function listThreadsAction(): Promise<ChatThreadSummary[]> {
  const access = await requireTenantPermission('work.read')
  return listThreads(access.tenantId, access.user.id)
}

export async function getThreadAction(
  threadId: string,
): Promise<{ thread: ChatThreadView; messages: ChatMessageView[] } | null> {
  if (!threadId) return null
  const access = await requireTenantPermission('work.read')
  return getThread(access.tenantId, threadId)
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
    await sendMessage({ tenantId: access.tenantId, threadId, userId: access.user.id, body: opening })
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
  })
  revalidatePath(CHAT_PATH)
  return result
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
