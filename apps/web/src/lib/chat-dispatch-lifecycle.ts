export type ChatDispatchStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

/** Mirrors the database trigger in migration 0063; both boundaries reject every other edge. */
export const CHAT_DISPATCH_TRANSITIONS: Record<ChatDispatchStatus, readonly ChatDispatchStatus[]> = {
  queued: ['running', 'cancelled'],
  running: ['completed', 'failed'],
  completed: [],
  failed: ['queued', 'cancelled'],
  cancelled: [],
}

export function assertChatDispatchTransition(from: ChatDispatchStatus, to: ChatDispatchStatus): void {
  if (!CHAT_DISPATCH_TRANSITIONS[from].includes(to)) {
    throw new Error(`A ${from} queued message cannot become ${to}.`)
  }
}
