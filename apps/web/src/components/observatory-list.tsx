'use client'

import { useRouter } from 'next/navigation'
import { Badge, EmptyState, PagedTable, type PagedColumn } from '@appkit/ui'

export type ObservatoryRunRow = {
  id: string
  agent: string
  agentTitle: string
  /** The agent's figure, cropped to its head viewport by the caller. */
  avatar: React.ReactNode
  trigger: string
  status: 'running' | 'waiting_approval' | 'waiting_reply' | 'completed' | 'failed' | 'cancelled'
  statusLabel: string
  summary: string
  started: string
  /** ISO timestamp, for sorting. */
  startedAt: string
  cost: string
  /** Raw dollars, for sorting the formatted cost column. */
  costUsd: number
}

const STATUS_VARIANT = (value: string) =>
  value === 'completed'
    ? ('default' as const)
    : value === 'running'
      ? ('secondary' as const)
      : value === 'failed'
        ? ('destructive' as const)
        : ('outline' as const)

const COLUMNS: PagedColumn<ObservatoryRunRow>[] = [
  {
    key: 'agent',
    header: 'Agent',
    cell: (row) => (
      <span className="flex items-center gap-2">
        {row.avatar}
        <span className="min-w-0">
          <span className="block truncate font-medium text-primary">{row.agent}</span>
          <span className="block truncate text-xs text-fg-muted">{row.agentTitle}</span>
        </span>
      </span>
    ),
    search: (row) => `${row.agent} ${row.agentTitle}`,
    sortValue: (row) => row.agent,
  },
  {
    key: 'trigger',
    header: 'Trigger',
    cell: (row) => row.trigger,
    search: (row) => row.trigger,
    sortValue: (row) => row.trigger,
  },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => <Badge variant={STATUS_VARIANT(row.status)}>{row.statusLabel}</Badge>,
    search: (row) => row.statusLabel,
    sortValue: (row) => row.statusLabel,
  },
  {
    key: 'summary',
    header: 'Summary',
    cell: (row) => <span className="block max-w-md truncate">{row.summary}</span>,
    search: (row) => row.summary,
  },
  {
    key: 'started',
    header: 'Started',
    cell: (row) => row.started,
    search: (row) => row.started,
    sortValue: (row) => row.startedAt,
  },
  {
    key: 'cost',
    header: 'Cost',
    align: 'right',
    cell: (row) => row.cost,
    sortValue: (row) => row.costUsd,
  },
]

/** The observatory floor: every run across every agent, newest first. */
export function ObservatoryList({ rows, basePath }: { rows: ObservatoryRunRow[]; basePath: string }) {
  const router = useRouter()

  return (
    <PagedTable
      columns={COLUMNS}
      rows={rows}
      rowKey={(row) => row.id}
      pageSize={25}
      searchable
      defaultSort={{ key: 'started', dir: 'desc' }}
      onRowClick={(row) => router.push(`${basePath}?run=${row.id}`, { scroll: false })}
      labels={{ searchPlaceholder: 'Search runs…', searchLabel: 'Search runs' }}
      empty={
        <EmptyState
          title="Nothing on the floor yet"
          description="Runs appear here the moment an agent starts working — from mail, duties, chat, or delegation."
        />
      }
    />
  )
}
