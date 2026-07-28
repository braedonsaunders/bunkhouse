'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Avatar, RecordList, type RecordColumn } from '@appkit/ui'

export type ObservatoryRunRow = {
  id: string
  hand: string
  handTitle: string
  avatarSrc?: string
  trigger: string
  status: 'running' | 'waiting_approval' | 'waiting_reply' | 'completed' | 'failed' | 'cancelled'
  statusLabel: string
  summary: string
  started: string
  /** ISO timestamp, for sorting. */
  startedAt: string
  cost: string
}

const STATUS_VARIANT = (value: string) =>
  value === 'completed'
    ? ('default' as const)
    : value === 'running'
      ? ('secondary' as const)
      : value === 'failed'
        ? ('destructive' as const)
        : ('outline' as const)

const COLUMNS: RecordColumn<ObservatoryRunRow>[] = [
  {
    key: 'hand',
    label: 'Hand',
    sortable: true,
    render: (row) => (
      <span className="flex items-center gap-2">
        <Avatar name={row.hand} size={26} {...(row.avatarSrc ? { src: row.avatarSrc } : {})} />
        <span className="min-w-0">
          <span className="block truncate font-medium text-primary">{row.hand}</span>
          <span className="block truncate text-xs text-fg-muted">{row.handTitle}</span>
        </span>
      </span>
    ),
  },
  { key: 'trigger', label: 'Trigger', sortable: true },
  { key: 'statusLabel', label: 'Status', kind: 'status', sortable: true, statusVariant: STATUS_VARIANT },
  {
    key: 'summary',
    label: 'Summary',
    render: (row) => <span className="block max-w-md truncate">{row.summary}</span>,
  },
  { key: 'started', label: 'Started', sortable: true },
  { key: 'cost', label: 'Cost', align: 'right', format: (v) => <span className="tabular-nums">{v as string}</span> },
]

/** The observatory floor: every run across every hand, newest first. */
export function ObservatoryList({ rows }: { rows: ObservatoryRunRow[] }) {
  const router = useRouter()
  const [search, setSearch] = React.useState('')
  const [sort, setSort] = React.useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'started', dir: 'desc' })

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    const base = q
      ? rows.filter((r) =>
          [r.hand, r.handTitle, r.trigger, r.statusLabel, r.summary].some((v) => v.toLowerCase().includes(q)),
        )
      : rows
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...base].sort((a, b) => {
      const key = sort.key === 'started' ? 'startedAt' : (sort.key as keyof ObservatoryRunRow)
      return String(a[key] ?? '').localeCompare(String(b[key] ?? '')) * dir
    })
  }, [rows, search, sort])

  return (
    <RecordList
      columns={COLUMNS}
      rows={filtered}
      getRowId={(row) => row.id}
      search={{ value: search, onChange: setSearch, placeholder: 'Search runs…' }}
      sort={sort}
      onSortChange={(key) =>
        setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
      }
      linkRender={({ href, children, className }) => (
        <Link href={href} className={className}>
          {children}
        </Link>
      )}
      onRowClick={(row) => router.push(`/runs/${row.id}?from=observatory`)}
      empty={{
        title: 'Nothing on the floor yet',
        description: 'Runs appear here the moment a hand starts working — from mail, duties, chat, or delegation.',
      }}
    />
  )
}
