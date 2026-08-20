'use client'

import * as React from 'react'
import {
  AlertCircle,
  AppWindow,
  Briefcase,
  Calculator,
  CalendarClock,
  Check,
  FileText,
  FolderOpen,
  Globe,
  Hand,
  Loader2,
  Mail,
  MessageCircleQuestion,
  MessageSquare,
  MonitorSmartphone,
  NotebookPen,
  PhoneOutgoing,
  Plug,
  Search,
  Table2,
  TerminalSquare,
  Users,
  Video,
  type LucideIcon,
} from 'lucide-react'
import { Badge } from '@braedonsaunders/appkit-ui'
import type { ToolActivityItem } from '../lib/call-activity'

/**
 * One tool call as the caller sees it: what the agent is doing, on which
 * system, and whether it is still running, finished, failed, or parked for
 * approval. Rendered inline with the transcript on the unified call stage and on
 * the finished call record — the same widget in both places.
 */

const TOOL_ICONS: Record<string, LucideIcon> = {
  web_search: Search,
  read_webpage: Globe,
  send_email: Mail,
  email_colleague: Mail,
  post_to_conversation: MessageSquare,
  start_subagent: Users,
  invoke_report: Users,
  await_launched_work: Users,
  save_memory: NotebookPen,
  search_memory: NotebookPen,
  schedule_task: CalendarClock,
  list_scheduled_tasks: CalendarClock,
  cancel_scheduled_task: CalendarClock,
  take_assignment: Briefcase,
  create_document: FileText,
  create_spreadsheet: Table2,
  reply_to_thread: Mail,
  run_script: Calculator,
  run_shell: TerminalSquare,
  list_workspace_files: FolderOpen,
  read_workspace_file: FolderOpen,
  publish_workspace_file: FileText,
  ask_and_wait: MessageCircleQuestion,
  delegate_to_colleague: Briefcase,
  place_call: PhoneOutgoing,
  send_sms: MessageSquare,
  read_file: FileText,
  revise_document: FileText,
  browser_open: MonitorSmartphone,
  browser_click: MonitorSmartphone,
  browser_type: MonitorSmartphone,
  browser_read: MonitorSmartphone,
  browser_screenshot: MonitorSmartphone,
  browser_close: MonitorSmartphone,
  open_desktop: AppWindow,
  close_desktop: AppWindow,
  desktop_screenshot: AppWindow,
  desktop_click: AppWindow,
  desktop_type: AppWindow,
  desktop_key: AppWindow,
  desktop_scroll: AppWindow,
  desktop_drag: AppWindow,
  desktop_invoke: AppWindow,
  desktop_windows: AppWindow,
  desktop_focus: AppWindow,
  desktop_open_app: AppWindow,
  request_takeover: Hand,
  run_tool: TerminalSquare,
  list_tools: TerminalSquare,
  send_meeting_link: Video,
}

/**
 * A tool's mark on its own — the same icon the card uses, for surfaces that
 * name one action rather than list them (the call stage's live status line).
 * Anything without a mark of its own is an integration: a plug.
 */
export function ToolMark({ toolName, className }: { toolName: string; className?: string }) {
  const Icon = TOOL_ICONS[toolName] ?? Plug
  return <Icon aria-hidden className={className ?? 'size-4'} />
}

function StatusMark({ status }: { status: ToolActivityItem['status'] }) {
  switch (status) {
    case 'running':
      return <Loader2 aria-label="Running" className="size-4 shrink-0 animate-spin text-fg-muted" />
    case 'done':
      return <Check aria-label="Done" className="size-4 shrink-0 text-success" />
    case 'failed':
      return <AlertCircle aria-label="Failed" className="size-4 shrink-0 text-danger" />
    case 'queued':
      return (
        <Badge variant="warning" className="shrink-0">
          Queued for approval
        </Badge>
      )
  }
}

export function ToolActivityCard({ item }: { item: ToolActivityItem }) {
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
        item.status === 'failed' ? 'border-danger/40 bg-danger-subtle/40' : 'border-border bg-bg-subtle'
      }`}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-bg text-fg-muted">
        <ToolMark toolName={item.toolName} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg">{item.label}</p>
        {item.detail ? <p className="truncate text-xs text-fg-muted">{item.detail}</p> : null}
      </div>
      <StatusMark status={item.status} />
    </div>
  )
}
