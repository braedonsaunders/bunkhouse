'use client'

import * as React from 'react'
import Link from 'next/link'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PagedTable,
  type PagedColumn,
} from '@appkit/ui'
import type { ToolActivityItem } from '../lib/call-activity'
import { ToolActivityCard } from './tool-activity'

export type DeskEvent = {
  id: string
  seq: number
  kind: string
  /** ISO timestamp. */
  at: string
  payload: Record<string, unknown>
}

export type ProcedureArtifact = {
  slug: string
  version: number
  title: string
  status: string
  /** Markdown body of the exact revision the agent followed. */
  body: string
}

export type CallTranscriptTurn = {
  speaker: 'agent' | 'human'
  text: string
  /** Offset from call start, milliseconds. */
  atMs: number
}

export type ApprovalArtifact = {
  id: string
  category: string
  description: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  decidedBy: string | null
  decidedAt: string | null
  decisionNote: string | null
  expiresAt: string | null
}

const KIND_LABELS: Record<string, string> = {
  thought: 'Thought',
  message: 'Message',
  tool_call: 'Tool call',
  tool_result: 'Tool result',
  procedure_citation: 'Procedure cited',
  approval_request: 'Approval requested',
  delegation: 'Delegation',
  error: 'Error',
  trace: 'Record',
}

const KIND_VARIANT: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  message: 'default',
  tool_call: 'secondary',
  approval_request: 'outline',
  procedure_citation: 'outline',
  delegation: 'outline',
  error: 'destructive',
  trace: 'outline',
}

/**
 * One line for a trace row: what it records, and the fact it turns on. The
 * whole payload is on the screen beside it — this is the part that has to be
 * readable at a glance while scrolling a call, because these rows are how you
 * find the utterance nothing caused or the answer nobody heard.
 */
function traceLine(p: Record<string, unknown>): string {
  const fact = String(p.trace ?? 'record')
  switch (fact) {
    case 'turn':
      return `Agent turn — ${String(p.cause ?? 'unknown cause')}${p.sameWordsAs ? ' · same words as an earlier turn' : ''}`
    case 'mailbox':
      return `Mailbox ${String(p.decision ?? '')} — ${String(p.kind ?? '')}${p.reason ? ` · ${String(p.reason)}` : ''}`
    case 'work_handed_over':
      return `Work handed over (${String(p.workId ?? '')}) — ${String(p.intent ?? '')}`
    case 'work_settled':
      return `Work settled (${String(p.workId ?? '')}) — ${String(p.status ?? '')}`
    case 'work_answer_spoken':
      return `Answer spoken to the caller (${String(p.workId ?? '')})`
    case 'work_answer_undelivered':
      return `Answer NEVER reached the caller (${String(p.workId ?? '')})`
    case 'work_deferred':
      return `Work refiled to finish after the call (${String(p.workId ?? '')}) — ${p.refiled ? 'refiled' : 'could not be'}`
    case 'delivery_unspoken':
      return `A delivery was made and the agent said nothing — ${String((p.deliveryKinds as string[] | undefined)?.join(', ') ?? '')}`
    case 'page_access':
      return `Page reading on this call — ${String(p.route ?? '')}`
    default:
      return fact.replace(/_/g, ' ')
  }
}

const APPROVAL_VARIANT: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  approved: 'default',
  pending: 'secondary',
  rejected: 'destructive',
  expired: 'outline',
}

function preview(event: DeskEvent): string {
  const p = event.payload
  switch (event.kind) {
    case 'message':
      return String(p.text ?? '')
    case 'thought':
      return String(p.text ?? JSON.stringify(p))
    case 'error':
      return String(p.message ?? '')
    case 'procedure_citation':
      return `${p.slug} v${p.version}`
    case 'approval_request':
      return String(p.description ?? '')
    case 'tool_call':
      return `${p.toolName}(…)`
    case 'tool_result':
      return `${p.toolName} → done`
    case 'trace':
      return traceLine(p)
    default:
      return JSON.stringify(p)
  }
}

function timeOf(at: string): string {
  return at.slice(11, 19)
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

/** Renders a tool input/output as key → value rows; falls back to pretty JSON. */
function KeyValueBlock({ value }: { value: unknown }) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return <p className="text-sm text-fg-muted">Empty.</p>
    return (
      <dl className="space-y-2">
        {entries.map(([key, v]) => (
          <div key={key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2.5fr)] gap-2 rounded-md bg-bg-subtle p-2">
            <dt className="break-words font-mono text-xs text-fg-muted">{key}</dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words font-mono text-xs text-fg">{formatValue(v)}</dd>
          </div>
        ))}
      </dl>
    )
  }
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-bg-subtle p-3 font-mono text-xs text-fg">
      {JSON.stringify(value ?? null, null, 2)}
    </pre>
  )
}

function Screen({
  event,
  procedures,
  approvals,
}: {
  event: DeskEvent
  procedures: Record<string, ProcedureArtifact>
  approvals: Record<string, ApprovalArtifact>
}) {
  const p = event.payload
  switch (event.kind) {
    case 'tool_call':
      return (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold">{String(p.toolName)}</span>
            {p.category ? <Badge variant="outline">{String(p.category)}</Badge> : null}
          </div>
          <KeyValueBlock value={p.input ?? {}} />
        </div>
      )
    case 'tool_result':
      return (
        <div className="space-y-3">
          <span className="font-mono text-sm font-semibold">{String(p.toolName)} — result</span>
          <KeyValueBlock value={p.output ?? {}} />
        </div>
      )
    case 'message':
      return <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg">{String(p.text ?? '')}</p>
    case 'thought':
      return (
        <p className="whitespace-pre-wrap text-sm italic leading-relaxed text-fg-muted">
          {String(p.text ?? JSON.stringify(p))}
        </p>
      )
    case 'procedure_citation': {
      const artifact = procedures[`${p.slug}@v${p.version}`]
      if (!artifact) {
        return (
          <EmptyState
            title="Revision unavailable"
            description={`Procedure ${String(p.slug)} v${String(p.version)} is cited but its revision could not be loaded.`}
          />
        )
      }
      return (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{artifact.title}</span>
            <Badge>v{artifact.version}</Badge>
            <Badge variant={artifact.status === 'active' ? 'default' : 'outline'}>{artifact.status}</Badge>
          </div>
          <div className="whitespace-pre-wrap rounded-md border border-border bg-bg-subtle p-3 text-sm text-fg">
            {artifact.body}
          </div>
          <p className="text-xs text-fg-muted">
            The exact revision the agent followed — pinned by version, so later edits never rewrite this record.
          </p>
        </div>
      )
    }
    case 'approval_request': {
      const approval = approvals[String(p.approvalId)]
      return (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{String(approval?.category ?? p.category ?? 'action')}</Badge>
            <Badge variant={APPROVAL_VARIANT[approval?.status ?? 'pending'] ?? 'outline'}>
              {approval?.status ?? 'pending'}
            </Badge>
          </div>
          <div className="rounded-md border border-border bg-bg-subtle p-3 text-sm text-fg">
            {String(approval?.description ?? p.description ?? '')}
          </div>
          {approval?.status === 'pending' ? (
            <div className="flex items-center gap-2">
              <Button asChild size="sm" variant="outline">
                <Link href="/approvals">Review in Approvals</Link>
              </Button>
              {approval.expiresAt ? (
                <span className="text-xs text-fg-muted">expires {approval.expiresAt.slice(0, 16).replace('T', ' ')}</span>
              ) : null}
            </div>
          ) : null}
          {approval && approval.status !== 'pending' ? (
            <p className="text-xs text-fg-muted">
              {approval.status}
              {approval.decidedBy ? ` by ${approval.decidedBy}` : ''}
              {approval.decidedAt ? ` · ${approval.decidedAt.slice(0, 16).replace('T', ' ')}` : ''}
              {approval.decisionNote ? ` — “${approval.decisionNote}”` : ''}
            </p>
          ) : null}
        </div>
      )
    }
    case 'error':
      return (
        <div className="rounded-md border border-danger bg-danger-subtle p-3 text-sm text-danger">
          {String(p.message ?? '')}
        </div>
      )
    case 'trace':
      return (
        <div className="space-y-3">
          <p className="text-sm font-semibold text-fg">{traceLine(p)}</p>
          <KeyValueBlock value={p} />
        </div>
      )
    default:
      return <KeyValueBlock value={p} />
  }
}

/**
 * The activity subtab: the append-only ledger as a searchable, sortable table,
 * and beside it whatever was on the agent's screen at the selected moment.
 * With nothing selected the desk follows the newest event.
 */
export function RunActivity({
  events,
  procedures,
  approvals,
}: {
  events: DeskEvent[]
  procedures: Record<string, ProcedureArtifact>
  approvals: Record<string, ApprovalArtifact>
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const latest = events[events.length - 1] ?? null
  const selected = events.find((e) => e.id === selectedId) ?? latest
  const following = selectedId === null || selected?.id === latest?.id

  const columns: PagedColumn<DeskEvent>[] = React.useMemo(
    () => [
      {
        key: 'at',
        header: 'Time',
        cell: (row) => <span className="tabular-nums text-fg-muted">{timeOf(row.at)}</span>,
        search: (row) => timeOf(row.at),
        sortValue: (row) => row.seq,
      },
      {
        key: 'kind',
        header: 'Event',
        cell: (row) => (
          <Badge variant={KIND_VARIANT[row.kind] ?? 'outline'}>{KIND_LABELS[row.kind] ?? row.kind}</Badge>
        ),
        search: (row) => KIND_LABELS[row.kind] ?? row.kind,
        sortValue: (row) => KIND_LABELS[row.kind] ?? row.kind,
      },
      {
        key: 'detail',
        header: 'Detail',
        cell: (row) => <span className="block max-w-xl truncate text-fg-muted">{preview(row)}</span>,
        search: (row) => preview(row),
      },
    ],
    [],
  )

  if (events.length === 0) {
    return (
      <EmptyState title="No events" description="This run recorded nothing before finishing." />
    )
  }

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2 text-base">
            Activity
            {!following ? (
              <Button size="sm" variant="outline" onClick={() => setSelectedId(null)}>
                Jump to latest
              </Button>
            ) : null}
          </CardTitle>
          <CardDescription>Append-only record of everything this run did — the audit trail.</CardDescription>
        </CardHeader>
        <CardContent>
          <PagedTable
            columns={columns}
            rows={events}
            rowKey={(row) => row.id}
            pageSize={15}
            searchable
            defaultSort={{ key: 'at', dir: 'desc' }}
            onRowClick={(row) => setSelectedId(row.id)}
            rowClassName={(row) => (selected?.id === row.id ? 'bg-primary-subtle' : undefined)}
            labels={{ searchPlaceholder: 'Search events…', searchLabel: 'Search events' }}
            empty={<EmptyState title="No events" description="This run recorded nothing." />}
          />
        </CardContent>
      </Card>

      <Card className="xl:sticky xl:top-0">
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2 text-base">
            On their screen
            {selected ? (
              <Badge variant={selected.kind === 'error' ? 'destructive' : 'secondary'}>
                {KIND_LABELS[selected.kind] ?? selected.kind}
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription>
            {selected
              ? `Event ${selected.seq + 1} of ${events.length} · ${timeOf(selected.at)}${following ? ' · following latest' : ''}`
              : 'Select an event in the table.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {selected ? <Screen event={selected} procedures={procedures} approvals={approvals} /> : null}
        </CardContent>
      </Card>
    </div>
  )
}

function offsetLabel(atMs: number): string {
  return `${Math.floor(atMs / 60000)}:${String(Math.floor((atMs % 60000) / 1000)).padStart(2, '0')}`
}

/**
 * The call ledger rendered as chat bubbles. Tool activity from the same run
 * interleaves on the call clock, so the record reads the way the call
 * happened: said, did, said.
 */
export function RunTranscript({
  transcript,
  activity,
  agentName,
}: {
  transcript: CallTranscriptTurn[]
  activity: ToolActivityItem[]
  agentName: string
}) {
  const feed: ({ sort: number } & ({ type: 'turn'; turn: CallTranscriptTurn } | { type: 'tool'; item: ToolActivityItem }))[] = [
    ...transcript.map((turn) => ({ type: 'turn' as const, sort: turn.atMs, turn })),
    ...activity.map((item) => ({ type: 'tool' as const, sort: item.atMs, item })),
  ]
  feed.sort((a, b) => a.sort - b.sort)

  if (feed.length === 0) {
    return <EmptyState title="No turns recorded" description="The call ended before anything was transcribed." />
  }

  return (
    <div className="space-y-2">
      {feed.map((entry, index) =>
        entry.type === 'tool' ? (
          <ToolActivityCard key={entry.item.key} item={entry.item} />
        ) : (
          <div key={index} className={`flex ${entry.turn.speaker === 'human' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                entry.turn.speaker === 'human'
                  ? 'bg-primary-subtle text-fg'
                  : 'border border-border bg-bg-subtle text-fg'
              }`}
            >
              <p className="mb-0.5 text-xs font-medium text-fg-muted">
                {entry.turn.speaker === 'human' ? 'Caller' : agentName} ·{' '}
                <span className="tabular-nums">{offsetLabel(entry.turn.atMs)}</span>
              </p>
              <p className="whitespace-pre-wrap">{entry.turn.text}</p>
            </div>
          </div>
        ),
      )}
    </div>
  )
}
