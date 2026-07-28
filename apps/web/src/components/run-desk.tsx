'use client'

import * as React from 'react'
import Link from 'next/link'
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState } from '@appkit/ui'

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
  /** Markdown body of the exact revision the hand followed. */
  body: string
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
}

const KIND_TINT: Record<string, string> = {
  thought: 'text-fg-muted',
  message: 'text-info',
  tool_call: 'text-fg',
  tool_result: 'text-fg-muted',
  procedure_citation: 'text-primary',
  approval_request: 'text-warning',
  delegation: 'text-info',
  error: 'text-danger',
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
            The exact revision the hand followed — pinned by version, so later edits never rewrite this record.
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
    default:
      return <KeyValueBlock value={p} />
  }
}

/**
 * The desk view: the event feed on the left, and on the right whatever was on
 * the hand's screen at the selected moment. Clicking a feed line selects it;
 * with nothing selected the desk follows the latest event.
 */
export function RunDesk({
  events,
  procedures,
  approvals,
}: {
  events: DeskEvent[]
  procedures: Record<string, ProcedureArtifact>
  approvals: Record<string, ApprovalArtifact>
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const selected = events.find((e) => e.id === selectedId) ?? events[events.length - 1] ?? null
  const following = selectedId === null || selected?.id === events[events.length - 1]?.id

  if (events.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <EmptyState title="No events" description="This run recorded nothing before finishing." />
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
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
          <ol className="max-h-[32rem] space-y-0.5 overflow-y-auto rounded-md border border-border bg-bg-subtle p-2 font-mono text-xs">
            {events.map((event) => {
              const isSelected = selected?.id === event.id
              return (
                <li key={event.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(event.id)}
                    aria-current={isSelected}
                    className={`flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left transition-colors ${
                      isSelected ? 'bg-primary-subtle text-fg' : 'hover:bg-surface-hover'
                    }`}
                  >
                    <span className="shrink-0 tabular-nums text-fg-subtle">{timeOf(event.at)}</span>
                    <span className={`shrink-0 font-semibold ${KIND_TINT[event.kind] ?? 'text-fg'}`}>
                      {KIND_LABELS[event.kind] ?? event.kind}
                    </span>
                    <span className="min-w-0 truncate text-fg-muted">{preview(event)}</span>
                  </button>
                </li>
              )
            })}
          </ol>
        </CardContent>
      </Card>

      <Card>
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
              : 'Select an event in the feed.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {selected ? <Screen event={selected} procedures={procedures} approvals={approvals} /> : null}
        </CardContent>
      </Card>
    </div>
  )
}
