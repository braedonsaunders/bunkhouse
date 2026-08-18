'use client'

import * as React from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { Badge, Button, Drawer, EmptyState, Input, Label, PagedTable, SubtabNav, type PagedColumn } from '@braedonsaunders/appkit-ui'
import { reconcileExternalEffectAction } from '../app/runs/run-actions'

/**
 * The run record's tabular sections — work product, approvals, computer use,
 * spend, and cited procedures. Every one is the shared PagedTable, so search,
 * sort, and paging behave identically wherever the record is opened.
 */

export type RunFileRow = {
  id: string
  filename: string
  kind: string
  /** Pre-formatted by the caller, so the byte formatter stays on the server. */
  size: string
  sizeBytes: number
  created: string
  createdAt: string
}

export function RunFilesTable({ rows }: { rows: RunFileRow[] }) {
  const columns: PagedColumn<RunFileRow>[] = [
    {
      key: 'filename',
      header: 'File',
      cell: (row) => (
        <a
          href={`/api/files/${row.id}`}
          download={row.filename}
          onClick={(event) => event.stopPropagation()}
          className="font-medium text-primary hover:underline"
        >
          {row.filename}
        </a>
      ),
      search: (row) => row.filename,
      sortValue: (row) => row.filename,
    },
    {
      key: 'kind',
      header: 'Kind',
      cell: (row) => <Badge variant="outline">{row.kind}</Badge>,
      search: (row) => row.kind,
      sortValue: (row) => row.kind,
    },
    {
      key: 'size',
      header: 'Size',
      align: 'right',
      cell: (row) => <span className="tabular-nums">{row.size}</span>,
      sortValue: (row) => row.sizeBytes,
    },
    {
      key: 'created',
      header: 'Filed',
      cell: (row) => <span className="tabular-nums text-fg-muted">{row.created}</span>,
      sortValue: (row) => row.createdAt,
    },
  ]

  return (
    <PagedTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      pageSize={10}
      searchable
      defaultSort={{ key: 'created', dir: 'asc' }}
      labels={{ searchPlaceholder: 'Search files…', searchLabel: 'Search files' }}
      empty={
        <EmptyState
          title="No work product"
          description="Documents, spreadsheets, and attachments this run produced or received are filed here."
        />
      }
    />
  )
}

export type RunApprovalRow = {
  id: string
  category: string
  description: string
  status: string
  decidedBy: string
  decided: string
  decidedAt: string
  expires: string
  /** Whether the decision was actually acted on — '—' when there is nothing to act on. */
  carriedOut: string
  /** Why it was not, when it was not. */
  carriedOutDetail: string | null
}

const APPROVAL_VARIANT = (value: string) =>
  value === 'approved'
    ? ('default' as const)
    : value === 'pending'
      ? ('secondary' as const)
      : value === 'rejected'
        ? ('destructive' as const)
        : ('outline' as const)

export function RunApprovalsTable({ rows }: { rows: RunApprovalRow[] }) {
  const columns: PagedColumn<RunApprovalRow>[] = [
    {
      key: 'category',
      header: 'Category',
      cell: (row) => <Badge variant="outline">{row.category}</Badge>,
      search: (row) => row.category,
      sortValue: (row) => row.category,
    },
    {
      key: 'description',
      header: 'Asked to do',
      cell: (row) => <span className="block max-w-md truncate">{row.description}</span>,
      search: (row) => row.description,
    },
    {
      key: 'status',
      header: 'Decision',
      cell: (row) => <Badge variant={APPROVAL_VARIANT(row.status)}>{row.status}</Badge>,
      search: (row) => row.status,
      sortValue: (row) => row.status,
    },
    {
      key: 'decidedBy',
      header: 'Decided by',
      cell: (row) => row.decidedBy,
      search: (row) => row.decidedBy,
      sortValue: (row) => row.decidedBy,
    },
    {
      key: 'decided',
      header: 'Decided',
      cell: (row) => <span className="tabular-nums text-fg-muted">{row.decided}</span>,
      sortValue: (row) => row.decidedAt,
    },
    {
      key: 'carriedOut',
      header: 'Carried out',
      cell: (row) => (
        <span className="min-w-0">
          <span className={row.carriedOut === 'Not carried out' ? 'block text-danger' : 'block'}>{row.carriedOut}</span>
          {row.carriedOutDetail ? (
            <span className="block max-w-md truncate text-xs text-fg-muted">{row.carriedOutDetail}</span>
          ) : null}
        </span>
      ),
      search: (row) => `${row.carriedOut} ${row.carriedOutDetail ?? ''}`,
      sortValue: (row) => row.carriedOut,
    },
  ]

  return (
    <PagedTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      pageSize={10}
      searchable
      labels={{ searchPlaceholder: 'Search approvals…', searchLabel: 'Search approvals' }}
      empty={
        <EmptyState
          title="No approvals on this run"
          description="Actions above the agent's autonomy dial are parked here for a human decision."
        />
      }
    />
  )
}

export type RunAttemptRow = {
  id: string
  fence: number
  owner: string
  status: string
  startedAt: string
  lastAt: string
}

export function RunAttemptsTable({ rows }: { rows: RunAttemptRow[] }) {
  const columns: PagedColumn<RunAttemptRow>[] = [
    { key: 'fence', header: 'Attempt', cell: (row) => <span className="tabular-nums">#{row.fence}</span>, sortValue: (row) => row.fence },
    { key: 'owner', header: 'Executor', cell: (row) => <span className="block max-w-xs truncate text-fg-muted">{row.owner}</span>, search: (row) => row.owner },
    { key: 'status', header: 'Last event', cell: (row) => <Badge variant={row.status === 'failed' || row.status === 'lease_lost' ? 'destructive' : row.status === 'claimed' || row.status === 'renewed' ? 'secondary' : 'outline'}>{row.status.replaceAll('_', ' ')}</Badge>, search: (row) => row.status },
    { key: 'startedAt', header: 'Started', cell: (row) => <span className="tabular-nums text-fg-muted">{new Date(row.startedAt).toLocaleString()}</span>, sortValue: (row) => row.startedAt },
    { key: 'lastAt', header: 'Last activity', cell: (row) => <span className="tabular-nums text-fg-muted">{new Date(row.lastAt).toLocaleString()}</span>, sortValue: (row) => row.lastAt },
  ]
  return <PagedTable columns={columns} rows={rows} rowKey={(row) => row.id} pageSize={10} searchable labels={{ searchPlaceholder: 'Search attempts…', searchLabel: 'Search execution attempts' }} empty={<EmptyState title="No execution attempts" description="Runs that reached an executor record each fenced attempt here." />} />
}

export type RunEffectRow = {
  id: string
  kind: string
  idempotencyKey: string
  status: string
  createdAt: string
  lastAt: string
  request: unknown
  history: { seq: number; kind: string; at: string; payload: unknown }[]
}

export function RunEffectsTable({ rows }: { rows: RunEffectRow[] }) {
  const router = useRouter()
  const [selected, setSelected] = React.useState<RunEffectRow | null>(null)
  const [note, setNote] = React.useState('')
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [section, setSection] = React.useState<'request' | 'evidence' | 'resolve'>('request')
  const actionable =
    selected?.status === 'ambiguous' || selected?.status === 'intended' || selected?.status === 'retry_started'
  const reconcile = async (resolution: 'completed' | 'retry') => {
    if (!selected || pending) return
    setPending(true)
    setError(null)
    const result = await reconcileExternalEffectAction({ effectId: selected.id, resolution, note })
    setPending(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setSelected(null)
    setNote('')
    router.refresh()
  }
  const columns: PagedColumn<RunEffectRow>[] = [
    { key: 'kind', header: 'Effect', cell: (row) => <span className="font-medium">{row.kind.replaceAll('_', ' ')}</span>, search: (row) => row.kind },
    { key: 'status', header: 'Outcome', cell: (row) => <Badge variant={row.status === 'ambiguous' ? 'destructive' : row.status === 'completed' || row.status === 'reconciled' ? 'default' : 'outline'}>{row.status.replaceAll('_', ' ')}</Badge>, search: (row) => row.status },
    { key: 'idempotencyKey', header: 'Idempotency key', cell: (row) => <span className="block max-w-xs truncate font-mono text-xs text-fg-muted">{row.idempotencyKey}</span>, search: (row) => row.idempotencyKey },
    { key: 'createdAt', header: 'Intended', cell: (row) => <span className="tabular-nums text-fg-muted">{new Date(row.createdAt).toLocaleString()}</span>, sortValue: (row) => row.createdAt },
    { key: 'lastAt', header: 'Last evidence', cell: (row) => <span className="tabular-nums text-fg-muted">{new Date(row.lastAt).toLocaleString()}</span>, sortValue: (row) => row.lastAt },
  ]
  return (
    <>
      <PagedTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        pageSize={10}
        searchable
        onRowClick={(row) => {
          setSelected(row)
          setNote('')
          setError(null)
          setSection('request')
        }}
        labels={{ searchPlaceholder: 'Search external effects…', searchLabel: 'Search external effects' }}
        empty={
          <EmptyState
            title="No external effects"
            description="Actions that can change an outside system are intended and settled here."
          />
        }
      />
      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.kind.replaceAll('_', ' ') ?? 'External effect'}
        description="Immutable intent and outcome evidence"
        size="lg"
        footer={
          actionable && section === 'resolve' ? (
            <div className="flex w-full items-center justify-end gap-2">
              <Button variant="outline" disabled={pending || !note.trim()} onClick={() => void reconcile('retry')}>
                Confirm not completed
              </Button>
              <Button disabled={pending || !note.trim()} onClick={() => void reconcile('completed')}>
                Confirm completed
              </Button>
            </div>
          ) : undefined
        }
      >
        {selected ? (
          <div className="space-y-5">
            <dl className="grid grid-cols-2 gap-4">
              <div>
                <dt className="text-xs text-fg-muted">Outcome</dt>
                <dd className="mt-1">
                  <Badge variant="outline">{selected.status.replaceAll('_', ' ')}</Badge>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-fg-muted">Intended</dt>
                <dd className="mt-1 text-sm text-fg">{new Date(selected.createdAt).toLocaleString()}</dd>
              </div>
            </dl>
            <SubtabNav
              tabs={[
                { key: 'request', label: 'Request' },
                { key: 'evidence', label: `Evidence (${selected.history.length})` },
                { key: 'resolve', label: 'Resolve' },
              ]}
              active={section}
              onSelect={(key) => setSection(key as typeof section)}
              ariaLabel="External effect details"
            />
            {section === 'request' ? (
              <pre className="max-h-80 overflow-auto rounded-md border border-border bg-bg-subtle p-3 text-xs text-fg-muted">
                {JSON.stringify(selected.request, null, 2)}
              </pre>
            ) : section === 'evidence' ? (
              selected.history.length ? (
                <ol className="space-y-3">
                  {selected.history.map((event) => (
                    <li key={event.seq} className="rounded-md border border-border p-3">
                      <div className="flex items-center justify-between gap-3">
                        <Badge variant="outline">{event.kind.replaceAll('_', ' ')}</Badge>
                        <span className="text-xs tabular-nums text-fg-muted">{new Date(event.at).toLocaleString()}</span>
                      </div>
                      <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-fg-muted">
                        {JSON.stringify(event.payload, null, 2)}
                      </pre>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-fg-muted">No outcome has been recorded yet.</p>
              )
            ) : actionable ? (
              <div className="space-y-2">
                <Label htmlFor={`effect-note-${selected.id}`}>Resolution reason</Label>
                <Input
                  id={`effect-note-${selected.id}`}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="For example: confirmed in the destination audit log"
                />
                <p className="text-xs text-fg-muted">
                  Confirm completion only with independent evidence. Mark it not completed only after confirming the
                  destination did not apply the action; a future identical request may then retry it. A retry that still
                  holds an execution lease cannot be reconciled here.
                </p>
                {error ? <p className="text-sm text-danger">{error}</p> : null}
              </div>
            ) : (
              <p className="text-sm text-fg-muted">This effect already has authoritative outcome evidence.</p>
            )}
          </div>
        ) : null}
      </Drawer>
    </>
  )
}

/** Frames are captured at 1280×900, so the thumbnail keeps that exact ratio. */
const BROWSER_THUMBNAIL = { width: 128, height: 90 }

/** One recorded frame as a thumbnail, or an honest "no frame" placeholder. */
function FrameThumbnail({ fileId, alt }: { fileId: string | null; alt: string }) {
  if (!fileId) {
    return (
      <span className="flex h-[90px] w-32 items-center justify-center rounded border border-dashed border-border text-xs text-fg-subtle">
        no frame
      </span>
    )
  }
  return (
    <a
      href={`/api/files/${fileId}`}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
      className="inline-block"
    >
      <Image
        src={`/api/files/${fileId}`}
        alt={alt}
        width={BROWSER_THUMBNAIL.width}
        height={BROWSER_THUMBNAIL.height}
        loading="lazy"
        unoptimized
        className="rounded border border-border object-contain"
      />
    </a>
  )
}

export type RunBrowserStepRow = {
  seq: number
  action: string
  /** Human phrasing of the step, composed by the caller. */
  description: string
  url: string
  screenshotFileId: string | null
}

export function RunBrowserStepsTable({ rows }: { rows: RunBrowserStepRow[] }) {
  const columns: PagedColumn<RunBrowserStepRow>[] = [
    {
      key: 'seq',
      header: '#',
      align: 'right',
      cell: (row) => <span className="tabular-nums text-fg-muted">{row.seq}</span>,
      sortValue: (row) => row.seq,
    },
    {
      key: 'frame',
      header: 'Screen',
      cell: (row) => <FrameThumbnail fileId={row.screenshotFileId} alt={`Step ${row.seq}: ${row.action}`} />,
    },
    {
      key: 'description',
      header: 'Step',
      cell: (row) => <span className="block max-w-md">{row.description}</span>,
      search: (row) => `${row.description} ${row.action}`,
    },
    {
      key: 'url',
      header: 'Page',
      cell: (row) => <span className="block max-w-xs truncate text-fg-muted">{row.url}</span>,
      search: (row) => row.url,
      sortValue: (row) => row.url,
    },
  ]

  return (
    <PagedTable
      columns={columns}
      rows={rows}
      rowKey={(row) => String(row.seq)}
      pageSize={10}
      searchable
      defaultSort={{ key: 'seq', dir: 'asc' }}
      labels={{ searchPlaceholder: 'Search steps…', searchLabel: 'Search browser steps' }}
      empty={
        <EmptyState
          title="No browser steps"
          description="When an agent drives a browser, every step is recorded here with the screen as it looked."
        />
      }
    />
  )
}

export type RunDeskEventRow = {
  seq: number
  /** The typed ledger kind: shell_command, navigate, click, screen_open, … */
  kind: string
  /** Human phrasing of the event, composed by the caller. */
  description: string
  /** The recorded justification when the event opened a screen — §3.17. */
  reason: string | null
  /** Handover rows say explicitly that nothing typed was recorded. */
  note: string | null
  /** Where the event points: a page, a blocked host, or a working folder. */
  context: string
  screenshotFileId: string | null
}

const DESK_EVENT_VARIANT = (kind: string) =>
  kind === 'egress_blocked'
    ? ('destructive' as const)
    : kind === 'screen_open' || kind === 'handover_begin' || kind === 'handover_end'
      ? ('default' as const)
      : ('outline' as const)

/**
 * The desk replay: ONE interleaved stream — terminal, browser, and screen in
 * the order they happened, with the recorded frame inline wherever one was
 * captured. This is deliberately a single table (docs/agent-desk.md §3.19):
 * three separate ledgers would make an operator interleave them by timestamp,
 * and the seams are where things get missed.
 */
export function RunDeskEventsTable({ rows }: { rows: RunDeskEventRow[] }) {
  const columns: PagedColumn<RunDeskEventRow>[] = [
    {
      key: 'seq',
      header: '#',
      align: 'right',
      cell: (row) => <span className="tabular-nums text-fg-muted">{row.seq}</span>,
      sortValue: (row) => row.seq,
    },
    {
      key: 'frame',
      header: 'Screen',
      cell: (row) => <FrameThumbnail fileId={row.screenshotFileId} alt={`Event ${row.seq}: ${row.kind}`} />,
    },
    {
      key: 'description',
      header: 'Event',
      cell: (row) => (
        <span className="block max-w-md space-y-1">
          <span className="flex items-start gap-2">
            <Badge variant={DESK_EVENT_VARIANT(row.kind)}>{row.kind.replace(/_/g, ' ')}</Badge>
            <span className={row.kind === 'shell_command' ? 'font-mono text-xs leading-5' : undefined}>
              {row.description}
            </span>
          </span>
          {row.reason ? (
            <span className="block rounded-md border border-border bg-bg-subtle px-2 py-1 text-xs">
              <span className="text-fg-muted">Stated reason: </span>
              <span className="font-medium">{row.reason}</span>
            </span>
          ) : null}
          {row.note ? <span className="block text-xs text-fg-muted">{row.note}</span> : null}
        </span>
      ),
      search: (row) => `${row.description} ${row.kind} ${row.reason ?? ''}`,
    },
    {
      key: 'context',
      header: 'Where',
      cell: (row) =>
        row.context ? <span className="block max-w-xs truncate text-fg-muted">{row.context}</span> : '—',
      search: (row) => row.context,
      sortValue: (row) => row.context,
    },
  ]

  return (
    <PagedTable
      columns={columns}
      rows={rows}
      rowKey={(row) => String(row.seq)}
      pageSize={10}
      searchable
      defaultSort={{ key: 'seq', dir: 'asc' }}
      labels={{ searchPlaceholder: 'Search desk events…', searchLabel: 'Search desk events' }}
      empty={
        <EmptyState
          title="No desk events"
          description="Everything an agent does at its desk — terminal, browser, and screen — is recorded here in order."
        />
      }
    />
  )
}

export type RunSpendRow = {
  id: string
  at: string
  atIso: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cost: string
  costUsd: number
  priceSource: string
}

export function RunSpendTable({ rows }: { rows: RunSpendRow[] }) {
  const columns: PagedColumn<RunSpendRow>[] = [
    {
      key: 'at',
      header: 'When',
      cell: (row) => <span className="tabular-nums text-fg-muted">{row.at}</span>,
      sortValue: (row) => row.atIso,
    },
    {
      key: 'model',
      header: 'Model',
      cell: (row) => (
        <span className="min-w-0">
          <span className="block truncate font-medium">{row.model}</span>
          <span className="block truncate text-xs text-fg-muted">{row.provider}</span>
        </span>
      ),
      search: (row) => `${row.model} ${row.provider}`,
      sortValue: (row) => row.model,
    },
    {
      key: 'inputTokens',
      header: 'In',
      align: 'right',
      cell: (row) => <span className="tabular-nums">{row.inputTokens.toLocaleString()}</span>,
      sortValue: (row) => row.inputTokens,
    },
    {
      key: 'outputTokens',
      header: 'Out',
      align: 'right',
      cell: (row) => <span className="tabular-nums">{row.outputTokens.toLocaleString()}</span>,
      sortValue: (row) => row.outputTokens,
    },
    {
      key: 'priceSource',
      header: 'Priced',
      cell: (row) => (
        <Badge variant={row.priceSource === 'unpriced' ? 'destructive' : 'outline'}>{row.priceSource}</Badge>
      ),
      search: (row) => row.priceSource,
      sortValue: (row) => row.priceSource,
    },
    {
      key: 'cost',
      header: 'Cost',
      align: 'right',
      cell: (row) => <span className="tabular-nums">{row.cost}</span>,
      sortValue: (row) => row.costUsd,
    },
  ]

  return (
    <PagedTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      pageSize={10}
      searchable
      defaultSort={{ key: 'at', dir: 'asc' }}
      labels={{ searchPlaceholder: 'Search model calls…', searchLabel: 'Search model calls' }}
      empty={
        <EmptyState
          title="No model calls"
          description="Every model call this run made is metered here, with the price that was applied."
        />
      }
    />
  )
}

export type RunProcedureRow = {
  key: string
  slug: string
  title: string
  version: number
  status: string
  citedAt: string
  citedAtIso: string
  body: string
}

/** Cited revisions as a table; picking one shows the exact text that was followed. */
export function RunProceduresTable({ rows }: { rows: RunProcedureRow[] }) {
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null)
  const selected = rows.find((row) => row.key === selectedKey) ?? rows[0] ?? null

  const columns: PagedColumn<RunProcedureRow>[] = [
    {
      key: 'title',
      header: 'Procedure',
      cell: (row) => (
        <span className="min-w-0">
          <span className="block truncate font-medium text-primary">{row.title}</span>
          <span className="block truncate font-mono text-xs text-fg-muted">{row.slug}</span>
        </span>
      ),
      search: (row) => `${row.title} ${row.slug}`,
      sortValue: (row) => row.title,
    },
    {
      key: 'version',
      header: 'Version',
      cell: (row) => <Badge>v{row.version}</Badge>,
      sortValue: (row) => row.version,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => <Badge variant={row.status === 'active' ? 'default' : 'outline'}>{row.status}</Badge>,
      search: (row) => row.status,
      sortValue: (row) => row.status,
    },
    {
      key: 'citedAt',
      header: 'Cited',
      cell: (row) => <span className="tabular-nums text-fg-muted">{row.citedAt}</span>,
      sortValue: (row) => row.citedAtIso,
    },
  ]

  return (
    <div className="space-y-4">
      <PagedTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.key}
        pageSize={10}
        searchable
        defaultSort={{ key: 'citedAt', dir: 'asc' }}
        onRowClick={(row) => setSelectedKey(row.key)}
        rowClassName={(row) => (selected?.key === row.key ? 'bg-primary-subtle' : undefined)}
        labels={{ searchPlaceholder: 'Search procedures…', searchLabel: 'Search cited procedures' }}
        empty={
          <EmptyState
            title="No procedures cited"
            description="When an agent follows a procedure it cites the exact revision here, pinned by version."
          />
        }
      />
      {selected ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-fg">
            {selected.title} <span className="text-fg-muted">v{selected.version}</span>
          </p>
          <div className="whitespace-pre-wrap rounded-md border border-border bg-bg-subtle p-3 text-sm text-fg">
            {selected.body}
          </div>
          <p className="text-xs text-fg-muted">
            The exact revision the agent followed — pinned by version, so later edits never rewrite this record.
          </p>
        </div>
      ) : null}
    </div>
  )
}
