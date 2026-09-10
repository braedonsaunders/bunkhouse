import 'server-only'
import { chatLiveTurn, type ChatLiveTurn } from './chat-activity'
import { threadDutyIds } from './duty-conversation'
import { listThreadApprovals, type ChatApprovalView } from './chat-approvals'
import { listChatDispatches, type ChatDispatchView } from './chat-dispatch'
import { conversationIdFor, getThread, type ChatMessageView, type ChatThreadView } from './chat-threads'
import { listThreadSystemCredentialRequests, type SystemCredentialRequestView } from './system-credential-requests'

/**
 * Everything the conversation pane reads about one thread.
 *
 * One assembly, because there are two doors into this view — the chat page's
 * action and the agent record's server component — and they had drifted into
 * two copies of the same five reads. A field added to one was simply missing
 * from the other, which is how the agent record came to render a pane whose
 * in-progress turn could never appear.
 */
export type ChatThreadDetailView = {
  thread: ChatThreadView
  messages: ChatMessageView[]
  dispatches: ChatDispatchView[]
  credentialRequests: SystemCredentialRequestView[]
  approvals: ChatApprovalView[]
  canDecideApprovals: boolean
  /** Work in progress, read from the run ledger. Provisional — never a transcript entry. */
  liveTurn: ChatLiveTurn | null
}

export async function chatThreadDetail(args: {
  tenantId: string
  threadId: string
  canDecideApprovals: boolean
}): Promise<ChatThreadDetailView | null> {
  const detail = await getThread(args.tenantId, args.threadId)
  if (!detail) return null
  // Runs already attributed to a recorded message: the transcript recovers their
  // work through its own activity, so the live view must not repeat it.
  const attributed = [
    ...new Set(
      detail.messages.flatMap((message) => (message.role === 'agent' && message.runId ? [message.runId] : [])),
    ),
  ]
  // Scheduled work the thread asked for counts as this thread's work in
  // progress: a duty run carries no conversation in its trigger, so without its
  // provenance a ten-minute duty looks like nothing happening.
  const dutyIds = await threadDutyIds(args.tenantId, args.threadId)
  const [dispatches, credentialRequests, approvals, liveTurn] = await Promise.all([
    listChatDispatches({ tenantId: args.tenantId, threadId: args.threadId }),
    listThreadSystemCredentialRequests(args.tenantId, args.threadId),
    listThreadApprovals(args.tenantId, args.threadId),
    chatLiveTurn(args.tenantId, conversationIdFor(args.threadId), attributed, dutyIds),
  ])
  return {
    ...detail,
    dispatches,
    credentialRequests,
    approvals,
    canDecideApprovals: args.canDecideApprovals,
    liveTurn,
  }
}
