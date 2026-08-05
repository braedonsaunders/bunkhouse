/**
 * Tool activity on a call, distilled from the run's event ledger into items a
 * caller can watch: one item per tool call, moving running → done/failed, or
 * parked as queued when the action needs human sign-off. Browser steps — the
 * other ledger a caller watches, frame by frame — are put into words here too.
 * Pure data in, pure data out — shared by the live call page (polling) and the
 * finished run view, so both render the same story from the same ledger.
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

/** The host of a URL, for saying where the agent is without the whole address. */
export const hostOf = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname
  } catch {
    return value.slice(0, 60)
  }
}

const INTEGRATION_NAMES: Record<string, string> = {
  netsuite: 'NetSuite',
  salesforce: 'Salesforce',
  hubspot: 'HubSpot',
  microsoft: 'Microsoft',
  google: 'Google',
  quickbooks: 'QuickBooks',
}

/**
 * MCP tools are namespaced for machines (`netsuite_ns_runCustomSuiteQL`). The
 * namespace is useful in a ledger but not something a caller or operator
 * should have read back to them as prose.
 */
function describeIntegrationTool(toolName: string): string {
  const [namespace = '', ...rest] = toolName.split('_')
  const integration = INTEGRATION_NAMES[namespace.toLowerCase()] ??
    `${namespace.slice(0, 1).toUpperCase()}${namespace.slice(1) || 'connected system'}`
  const operation = rest.join('_').toLowerCase()
  if (/send|email|message|notify/.test(operation)) return `Sending through ${integration}`
  if (/create|add|update|edit|write|delete|remove/.test(operation)) return `Updating ${integration}`
  return `Checking ${integration}`
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
    case 'take_assignment': {
      const t = quote(args.title)
      return t ? `Taking on ${t}` : 'Taking on the work'
    }
    case 'create_document': {
      const t = quote(args.title)
      const format = typeof args.format === 'string' ? args.format.toUpperCase() : null
      return t ? `Writing ${format ? `a ${format}` : 'a document'} — ${t}` : 'Writing a document'
    }
    case 'create_spreadsheet': {
      const t = quote(args.title)
      return t ? `Building a spreadsheet — ${t}` : 'Building a spreadsheet'
    }
    case 'reply_to_thread':
      return 'Sending the reply'
    case 'run_script':
      return 'Running a calculation'
    case 'run_shell': {
      const c = quote(args.command)
      return c ? `Working in the workspace — ${c}` : 'Working in the workspace'
    }
    case 'list_workspace_files':
      return 'Checking the workspace'
    case 'read_workspace_file':
      return 'Reading a workspace file'
    case 'publish_workspace_file':
      return 'Publishing a file'
    case 'ask_and_wait': {
      const to = typeof args.to === 'string' && args.to.trim() ? args.to.trim() : null
      return to ? `Asking ${to} and waiting to hear back` : 'Asking a question and waiting'
    }
    case 'delegate_to_colleague': {
      const t = quote(args.title)
      return t ? `Delegating ${t}` : 'Delegating work to a colleague'
    }
    case 'place_call': {
      const to = typeof args.to === 'string' && args.to.trim() ? args.to.trim() : null
      return to ? `Calling ${to}` : 'Placing a call'
    }
    case 'send_sms': {
      const to = typeof args.to === 'string' && args.to.trim() ? args.to.trim() : null
      return to ? `Texting ${to}` : 'Sending a text message'
    }
    case 'read_file':
      return 'Reading a file'
    case 'revise_document':
      return 'Revising a document'
    case 'browser_open': {
      const host = hostOf(args.url)
      return host ? `Opening ${host} in the browser` : 'Opening the browser'
    }
    case 'browser_click': {
      const t = quote(args.target)
      return t ? `Clicking ${t}` : 'Clicking in the browser'
    }
    case 'browser_type':
      return 'Typing in the browser'
    case 'browser_read':
      return 'Reading the page'
    case 'browser_screenshot':
      return 'Taking a screenshot'
    case 'browser_close':
      return 'Closing the browser'
    case 'send_meeting_link': {
      const to = typeof args.toEmail === 'string' && args.toEmail.trim() ? args.toEmail.trim() : null
      return to ? `Inviting ${to} to a video meeting` : 'Sending a meeting link'
    }
    default:
      return describeIntegrationTool(toolName)
  }
}

/** What a recorded browser step did beyond its verb — structural on purpose, so
 * this file stays free of database imports and runs on either side of the wire. */
export type BrowserStepWords = {
  url?: string
  title?: string
  target?: string
  text?: string
  error?: string
}

const BROWSER_STEP_VERBS: Record<string, string> = {
  open: 'Opened',
  click: 'Clicked',
  type: 'Typed into',
  read: 'Read',
  screenshot: 'Captured',
  close: 'Closed the browser',
}

/** One plain line per recorded step: what the agent did, and where it landed. */
export function describeBrowserStep(action: string, detail: BrowserStepWords): string {
  const verb = BROWSER_STEP_VERBS[action] ?? action
  const target = detail.target ?? detail.title ?? detail.url ?? ''
  const typed = detail.text ? ` — "${detail.text}"` : ''
  const failure = detail.error ? ` — ${detail.error}` : ''
  return `${verb}${target ? ` ${target}` : ''}${typed}${failure}`
}

/**
 * Pair the ledger back into items. Results and approval requests match their
 * call by toolName in arrival order — concurrent calls to the same tool
 * resolve first-in-first-out, which is the order the ledger recorded them.
 */
export function toolActivityFromEvents(events: CallActivityEvent[]): ToolActivityItem[] {
  const items: ToolActivityItem[] = []
  const open = new Map<string, ToolActivityItem[]>()
  // An approval parks a call rather than finishing it. Keep that call by the
  // approval's durable id so the executor's later result can move the same UI
  // item to done. Matching only through `open` lost the item the moment the
  // request was filed, leaving "Queued for approval" on screen after the
  // action had run successfully.
  const byApproval = new Map<string, ToolActivityItem>()
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

    const approvalId =
      typeof event.payload.approvedApprovalId === 'string'
        ? event.payload.approvedApprovalId
        : typeof event.payload.approvalId === 'string'
          ? event.payload.approvalId
          : null
    // A result ordinarily closes the oldest open call of that tool. Approval
    // results are different: the request already removed the call from the
    // open queue, so its durable approval id is authoritative. Older ledgers
    // lack one or both ids; their safe fallback is the latest queued call of
    // the same tool (or, for very old nameless requests, the latest live call).
    const item =
      (approvalId ? byApproval.get(approvalId) : undefined) ??
      open.get(toolName)?.shift() ??
      (event.kind === 'tool_result'
        ? [...items].reverse().find((candidate) => candidate.toolName === toolName && candidate.status === 'queued')
        : undefined) ??
      (toolName === ''
        ? [...items].reverse().find((candidate) => candidate.status === 'running' || candidate.status === 'queued')
        : undefined)
    if (!item) continue
    if (event.kind === 'approval_request') {
      item.status = 'queued'
      item.detail = 'Queued for approval — it runs once signed off.'
      if (approvalId) byApproval.set(approvalId, item)
      continue
    }
    const output =
      event.payload.output !== null && typeof event.payload.output === 'object'
        ? (event.payload.output as Record<string, unknown>)
        : null
    if (output && typeof output.error === 'string') {
      item.status = 'failed'
      item.detail = output.error.slice(0, 200)
    } else if (output && output.status === 'pending_approval') {
      // The governed loop files the request before the step it interrupted is
      // ledgered, so the tool's own result is what says the action is parked.
      item.status = 'queued'
      item.detail = 'Queued for approval — it runs once signed off.'
    } else if (output && output.status === 'forbidden') {
      item.status = 'failed'
      item.detail = 'This action is not enabled for this agent.'
    } else {
      item.status = 'done'
      item.detail = null
    }
    if (approvalId) byApproval.delete(approvalId)
  }
  return items
}
