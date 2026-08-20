import type { ChatDispatchStatus } from './chat-dispatch-lifecycle'

export type ChatDispatchUiRecord = {
  id: string
  body: string
  status: ChatDispatchStatus
  lastError: string | null
}

export type ChatQueueUiMessage = {
  id: string
  text: string
  position: number
  status: 'queued' | 'dispatching' | 'failed'
  statusLabel?: string
  editable: boolean
  removable: boolean
  retryable: boolean
}

export type ChatQueueUiProjection = {
  state: 'idle' | 'running' | 'recovering'
  messages: ChatQueueUiMessage[]
}

/** One tested projection from durable dispatch state to the AppKit queue surface. */
export function chatQueueUiProjection(dispatches: readonly ChatDispatchUiRecord[]): ChatQueueUiProjection {
  const running = dispatches.some((dispatch) => dispatch.status === 'running')
  const visible = dispatches.filter(
    (dispatch): dispatch is ChatDispatchUiRecord & { status: 'queued' | 'failed' } =>
      dispatch.status === 'queued' || dispatch.status === 'failed',
  )
  return {
    // A claimed dispatch has already appended its user turn to the immutable
    // transcript. Keep the running signal for typing/progress, but do not show
    // the same words again under “Up next.”
    state: running
      ? 'running'
      : visible.some((dispatch) => dispatch.status === 'failed')
        ? 'recovering'
        : 'idle',
    messages: visible.map((dispatch, index) => ({
      id: dispatch.id,
      text: dispatch.body,
      position: index + 1,
      status: dispatch.status,
      ...(dispatch.status === 'failed' && dispatch.lastError ? { statusLabel: dispatch.lastError } : {}),
      editable: dispatch.status === 'queued' || dispatch.status === 'failed',
      removable: dispatch.status === 'queued' || dispatch.status === 'failed',
      retryable: dispatch.status === 'failed',
    })),
  }
}
