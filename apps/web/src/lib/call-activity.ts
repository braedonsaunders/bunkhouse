/**
 * Tool activity on a call, distilled from the run's event ledger into items a
 * caller can watch: one item per tool call, moving running → done/failed, or
 * parked as queued when the action needs human sign-off. Browser steps — the
 * other ledger a caller watches, frame by frame — are put into words here too.
 * Pure data in, pure data out — shared by the live call stage (polling) and the
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
 *
 * The call's own words for what THIS call does ride along when the arguments
 * carry them: many integration tools take a `description` of the specific
 * query. Without it every NetSuite call on a run collapses to the identical
 * string "Checking NetSuite" — and the mailbox deduplicates on exact text, so
 * one five-minute financial analysis said those words once and then held the
 * line in silence for 103 seconds while ten more progress notes were dropped
 * as already-said.
 */
function describeIntegrationTool(toolName: string, args: Record<string, unknown>): string {
  const [namespace = '', ...rest] = toolName.split('_')
  const integration = INTEGRATION_NAMES[namespace.toLowerCase()] ??
    `${namespace.slice(0, 1).toUpperCase()}${namespace.slice(1) || 'connected system'}`
  const operation = rest.join('_').toLowerCase()
  const verb = /send|email|message|notify/.test(operation)
    ? `Sending through ${integration}`
    : /create|add|update|edit|write|delete|remove/.test(operation)
      ? `Updating ${integration}`
      : `Checking ${integration}`
  const detail = quote(args.description)
  if (detail) return `${verb} — ${detail}`
  const operationLabel = rest
    .join(' ')
    .replace(/\b(get|run)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return operationLabel ? `${verb} — ${operationLabel}` : verb
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
      return describeIntegrationTool(toolName, args)
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

/** What a recorded desk event carried beyond its kind — structural on purpose,
 * like BrowserStepWords: this file stays free of database imports and runs on
 * either side of the wire. Every field is optional; the kind says which slice
 * to expect (see DeskLedgerEventDetail in db/schema/desk.ts). */
export type DeskEventWords = BrowserStepWords & {
  command?: string
  cwd?: string
  exitCode?: number | null
  signal?: string | null
  x?: number
  y?: number
  button?: string
  combo?: string
  from?: { x: number; y: number }
  to?: { x: number; y: number }
  appId?: string
  args?: string[]
  window?: { id: string; title: string; appId: string | null }
  reason?: string
  actor?: string | null
  scope?: string
  durationMs?: number
  jobId?: string
  host?: string | null
  port?: number | null
}

const asDuration = (ms: number): string => {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

/**
 * One plain line per desk ledger event, in describeBrowserStep's style but for
 * the whole desk: the terminal, the browser (whose steps ride the same ledger),
 * and the desktop screen. `click`/`type` cover both vocabularies — a browser
 * click carries a target, a desktop click carries coordinates — so this one
 * function narrates a desk replay and a legacy browser frame alike.
 */
export function describeDeskEvent(kind: string, detail: DeskEventWords): string {
  const failure = detail.error ? ` — ${detail.error}` : ''
  const place = detail.target ?? detail.title ?? detail.url ?? ''
  switch (kind) {
    case 'shell_command': {
      const exit =
        detail.exitCode === null || detail.exitCode === undefined
          ? detail.signal
            ? ` — ${detail.signal}`
            : ''
          : ` — exit ${detail.exitCode}`
      return `Ran ${detail.command ? `"${detail.command}"` : 'a command'}${exit}${failure}`
    }
    case 'navigate':
      return `Opened${place ? ` ${place}` : ' a page'}${failure}`
    case 'read':
      return `Read${place ? ` ${place}` : ' the page'}${failure}`
    case 'screenshot':
      return `Captured the screen${failure}`
    case 'browser_close':
      return `Closed the browser${failure}`
    case 'app_launch':
      return `Launched ${detail.appId ?? 'an application'}${detail.args?.length ? ` ${detail.args.join(' ')}` : ''}${failure}`
    case 'click':
      if (place) return `Clicked ${place}${failure}`
      return typeof detail.x === 'number' && typeof detail.y === 'number'
        ? `Clicked at (${detail.x}, ${detail.y})${detail.button && detail.button !== 'left' ? ` — ${detail.button} button` : ''}${failure}`
        : `Clicked${failure}`
    case 'type':
      return `Typed${place ? ` into ${place}` : ''}${detail.text ? ` — "${detail.text}"` : ''}${failure}`
    case 'key':
      return `Pressed ${detail.combo ?? 'a key'}${failure}`
    case 'scroll':
      return `Scrolled${typeof detail.x === 'number' && typeof detail.y === 'number' ? ` at (${detail.x}, ${detail.y})` : ''}${failure}`
    case 'drag':
      return detail.from && detail.to
        ? `Dragged from (${detail.from.x}, ${detail.from.y}) to (${detail.to.x}, ${detail.to.y})${failure}`
        : `Dragged${failure}`
    case 'window_focus':
      return `Focused ${detail.window?.title ?? place ?? 'a window'}${failure}`
    case 'screen_open':
      return `Opened the desktop screen — ${detail.reason ?? 'no reason recorded'}`
    case 'screen_close':
      return 'Closed the desktop screen'
    case 'file_write':
      return `Published ${detail.title ?? detail.target ?? 'a file'}${failure}`
    case 'shared_write':
      return `Wrote to the shared folder${place ? ` — ${place}` : ''}${failure}`
    case 'egress_blocked':
      return `Blocked a connection to ${detail.host ?? 'an address'}${detail.port ? `:${detail.port}` : ''}`
    case 'handover_begin':
      return `Handed the screen to ${detail.actor ?? 'a person'}${detail.scope ? ` (${detail.scope})` : ''}${detail.reason ? ` — ${detail.reason}` : ''}`
    case 'handover_end':
      return `Handover ended${detail.actor ? ` — ${detail.actor}` : ''}${typeof detail.durationMs === 'number' ? ` after ${asDuration(detail.durationMs)}` : ''}`
    case 'job_start':
      return `Started a background job${detail.command ? ` — "${detail.command}"` : ''}`
    case 'job_exit':
      return `Background job exited${detail.exitCode === null || detail.exitCode === undefined ? '' : ` — exit ${detail.exitCode}`}`
    default:
      return describeBrowserStep(kind, detail)
  }
}

/**
 * A desk event as the replay tables want it, minus the row plumbing: the plain
 * line, the recorded screen-open reason surfaced on its own (§3.17 — it is the
 * reviewable part), the handover masking made explicit, and where the event
 * points. Shared by the run record and the operator's desk session drawer, so
 * both read the same story from the same ledger.
 */
export function deskEventPresentation(
  kind: string,
  detail: DeskEventWords,
): { description: string; reason: string | null; note: string | null; context: string } {
  return {
    description: describeDeskEvent(kind, detail),
    reason: kind === 'screen_open' ? (detail.reason ?? null) : null,
    note:
      kind === 'handover_begin' || kind === 'handover_end'
        ? 'Nothing typed during the handover was recorded — only that it happened, who drove, and for how long.'
        : null,
    context: detail.url ?? detail.host ?? detail.cwd ?? '',
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
