'use client'

import * as React from 'react'
import Image from 'next/image'
import { Badge, EmptyState, PagedTable, type PagedColumn } from '@appkit/ui'

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

/** Frames are captured at 1280×900, so the thumbnail keeps that exact ratio. */
const BROWSER_THUMBNAIL = { width: 128, height: 90 }

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
      cell: (row) =>
        row.screenshotFileId ? (
          <a
            href={`/api/files/${row.screenshotFileId}`}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="inline-block"
          >
            <Image
              src={`/api/files/${row.screenshotFileId}`}
              alt={`Step ${row.seq}: ${row.action}`}
              width={BROWSER_THUMBNAIL.width}
              height={BROWSER_THUMBNAIL.height}
              loading="lazy"
              unoptimized
              className="rounded border border-border object-contain"
            />
          </a>
        ) : (
          <span className="flex h-[90px] w-32 items-center justify-center rounded border border-dashed border-border text-xs text-fg-subtle">
            no frame
          </span>
        ),
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
