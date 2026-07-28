/**
 * Tool activity on a call, distilled from the run's event ledger into items a
 * caller can watch: one item per tool call, moving running → done/failed, or
 * parked as queued when the action needs human sign-off. Pure data in, pure
 * data out — shared by the live call page (polling) and the finished run view,
 * so both render the same story from the same ledger.
 */

export type CallActivityEvent = {
  seq: number
  kind: 'tool_call' | 'tool_result' | 'approval_request'
  /** Offset from the call's start, milliseconds. */
  atMs: number
  payload: Record<string, unknown>
}

export type ToolActivityStatus = 'running' | 'done' | 'failed' | 'queued'

export type ToolActivityItem = {
  /** Stable across polls: the tool_call event's seq anchors it. */
  key: string
  toolName: string
  status: ToolActivityStatus
  label: string
  /** Secondary line: a failure reason or the approval posture. */
  detail: string | null
  /** Offset from the call's start, milliseconds — where it sits in the transcript. */
  atMs: number
}

const quote = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return null
  return `“${text.length > 60 ? `${text.slice(0, 57)}…` : text}”`
}

const hostOf = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname
  } catch {
    return value.slice(0, 60)
  }
}

/** Human label for a tool call, from its name and arguments. */
export function describeToolCall(toolName: string, input: unknown): string {
  const args = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  switch (toolName) {
    case 'web_search': {
      const q = quote(args.query)
      return q ? `Searching the web — ${q}` : 'Searching the web'
    }
    case 'read_webpage': {
      const host = hostOf(args.url)
      return host ? `Reading ${host}` : 'Reading a web page'
    }
    case 'send_email':
    case 'email_colleague': {
      const to = typeof args.to === 'string' && args.to.trim() ? args.to.trim() : null
      return to ? `Sending email to ${to}` : 'Sending email'
    }
    case 'save_memory': {
      const t = quote(args.title)
      return t ? `Saving a note — ${t}` : 'Saving a note'
    }
    case 'search_memory': {
      const q = quote(args.query)
      return q ? `Searching the logbook — ${q}` : 'Searching the logbook'
    }
    case 'schedule_task': {
      const t = quote(args.title)
      return t ? `Scheduling ${t}` : 'Scheduling a follow-up'
    }
    case 'list_scheduled_tasks':
      return 'Reviewing scheduled tasks'
    case 'cancel_scheduled_task':
      return 'Cancelling a scheduled task'
    default:
      // Integration tools keep their own names, made readable.
      return `Using ${toolName.replace(/[_-]+/g, ' ')}`
  }
}

/**
 * Pair the ledger back into items. Results and approval requests match their
 * call by toolName in arrival order — concurrent calls to the same tool
 * resolve first-in-first-out, which is the order the ledger recorded them.
 */
export function toolActivityFromEvents(events: CallActivityEvent[]): ToolActivityItem[] {
  const items: ToolActivityItem[] = []
  const open = new Map<string, ToolActivityItem[]>()
  const sorted = [...events].sort((a, b) => a.seq - b.seq)

  for (const event of sorted) {
    const toolName = typeof event.payload.toolName === 'string' ? event.payload.toolName : ''
    if (event.kind === 'tool_call') {
      const item: ToolActivityItem = {
        key: `tool-${event.seq}`,
        toolName,
        status: 'running',
        label: describeToolCall(toolName, event.payload.input),
        detail: null,
        atMs: event.atMs,
      }
      items.push(item)
      const queue = open.get(toolName) ?? []
      queue.push(item)
      open.set(toolName, queue)
      continue
    }

    // A result or approval closes the oldest still-open call of that tool.
    // Older ledgers recorded approval requests without a toolName; fall back
    // to the most recent still-running item so nothing shows running forever.
    const item =
      open.get(toolName)?.shift() ??
      (toolName === '' ? [...items].reverse().find((i) => i.status === 'running') : undefined)
    if (!item) continue
    if (event.kind === 'approval_request') {
      item.status = 'queued'
      item.detail = 'Queued for approval — it runs once signed off.'
      continue
    }
    const output =
      event.payload.output !== null && typeof event.payload.output === 'object'
        ? (event.payload.output as Record<string, unknown>)
        : null
    if (output && typeof output.error === 'string') {
      item.status = 'failed'
      item.detail = output.error.slice(0, 200)
    } else if (output && output.status === 'forbidden') {
      item.status = 'failed'
      item.detail = 'This action is not enabled for this agent.'
    } else {
      item.status = 'done'
    }
  }
  return items
}
