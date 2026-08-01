'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { RecordList, type RecordColumn } from '@appkit/ui'
import type { CallAction } from '../lib/call-action'
import { CallActionButton } from './call-action-button'

/**
 * One row shape for both halves of the organization. People and agents get
 * their own pages and their own columns — a human has a phone, an agent has a
 * model and an extension — but they are the same record underneath, so the
 * list behavior, the drawer, and the reporting line stay identical.
 */
export type RosterRow = {
  id: string
  name: string
  /** The person's figure, cropped to its head viewport by the caller. */
  avatar: React.ReactNode
  title: string
  email: string
  reportsTo: string
  status: 'Onboarding' | 'Active' | 'Offboarded'
  phone?: string
  model?: string
  extension?: string
  /** Agents only: the row's Call action, resolved by `resolveCallAction`. */
  call?: CallAction | null
}

const NAME_COLUMN: RecordColumn<RosterRow> = {
  key: 'name',
  label: 'Name',
  sortable: true,
  render: (row) => (
    <span className="flex items-center gap-2 font-medium text-primary">
      {row.avatar}
      {row.name}
    </span>
  ),
}

const STATUS_COLUMN: RecordColumn<RosterRow> = {
  key: 'status',
  label: 'Status',
  kind: 'status',
  sortable: true,
  statusVariant: (value) => (value === 'Active' ? 'default' : value === 'Onboarding' ? 'secondary' : 'outline'),
}

/** Reach the agent straight from the row, without opening the record first. */
const CALL_COLUMN: RecordColumn<RosterRow> = {
  key: 'call',
  label: '',
  kind: 'actions',
  render: (row) => (row.call ? <CallActionButton action={row.call} name={row.name} compact /> : null),
}

export const PEOPLE_COLUMNS: RecordColumn<RosterRow>[] = [
  NAME_COLUMN,
  { key: 'title', label: 'Job title', sortable: true },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'reportsTo', label: 'Reports to', sortable: true },
  STATUS_COLUMN,
]

export const AGENT_COLUMNS: RecordColumn<RosterRow>[] = [
  NAME_COLUMN,
  { key: 'title', label: 'Role', sortable: true },
  { key: 'email', label: 'Mailbox' },
  { key: 'model', label: 'Model' },
  { key: 'extension', label: 'Ext.' },
  { key: 'reportsTo', label: 'Reports to', sortable: true },
  STATUS_COLUMN,
  CALL_COLUMN,
]

export function RosterList({
  rows,
  columns,
  basePath,
  searchPlaceholder,
  empty,
  selectedId,
}: {
  rows: RosterRow[]
  columns: RecordColumn<RosterRow>[]
  /** Where a row click opens the record drawer, e.g. `/organization/people`. */
  basePath: string
  searchPlaceholder: string
  empty: { title: string; description: string }
  /** The record the drawer has open, so its row reads as the live one. */
  selectedId?: string | undefined
}) {
  const router = useRouter()
  // The row clicked but not yet open. The record is fetched on the server, so
  // between the click and the drawer there is a wait with nothing in the URL
  // yet; without this the click is unacknowledged for the whole of it.
  const [opening, setOpening] = React.useState<string | null>(null)
  const [pending, startTransition] = React.useTransition()
  const [search, setSearch] = React.useState('')
  const [sort, setSort] = React.useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' })

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    const base = q
      ? rows.filter((row) =>
          [row.name, row.title, row.email, row.reportsTo, row.phone, row.model]
            .filter((value): value is string => typeof value === 'string')
            .some((value) => value.toLowerCase().includes(q)),
        )
      : rows
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...base].sort((a, b) => {
      const key = sort.key as keyof RosterRow
      return String(a[key] ?? '').localeCompare(String(b[key] ?? '')) * dir
    })
  }, [rows, search, sort])

  return (
    <RecordList
      columns={columns}
      rows={filtered}
      getRowId={(row) => row.id}
      search={{ value: search, onChange: setSearch, placeholder: searchPlaceholder }}
      sort={sort}
      onSortChange={(key) =>
        setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
      }
      linkRender={({ href, children, className }) => (
        <Link href={href} className={className}>
          {children}
        </Link>
      )}
      // While the record is on its way the clicked row is the live one; once it
      // lands the open record is, and closing the drawer clears both.
      activeRowId={pending ? opening : selectedId}
      onRowClick={(row) => {
        setOpening(row.id)
        // In a transition, so React keeps the roster on screen while the record
        // loads. A bare push runs at click priority, which lets the page fall
        // back to the route-level spinner — the whole list disappearing and
        // coming back, which reads as the page reloading before the drawer opens.
        startTransition(() => router.push(`${basePath}?person=${row.id}`, { scroll: false }))
      }}
      empty={empty}
    />
  )
}
