'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Avatar, RecordList, type RecordColumn } from '@appkit/ui'

export type PersonRow = {
  id: string
  name: string
  avatarSrc?: string
  title: string
  kind: 'Hand' | 'Human'
  email: string
  reportsTo: string
  status: 'Onboarding' | 'Active' | 'Offboarded'
}

const COLUMNS: RecordColumn<PersonRow>[] = [
  {
    key: 'name',
    label: 'Name',
    sortable: true,
    render: (row) => (
      <span className="flex items-center gap-2 font-medium text-primary">
        <Avatar name={row.name} size={26} {...(row.avatarSrc ? { src: row.avatarSrc } : {})} />
        {row.name}
      </span>
    ),
  },
  { key: 'title', label: 'Title', sortable: true },
  {
    key: 'kind',
    label: 'Kind',
    kind: 'status',
    sortable: true,
    statusVariant: (value) => (value === 'Hand' ? 'default' : 'secondary'),
  },
  { key: 'email', label: 'Email' },
  { key: 'reportsTo', label: 'Reports to' },
  {
    key: 'status',
    label: 'Status',
    kind: 'status',
    sortable: true,
    statusVariant: (value) => (value === 'Active' ? 'default' : value === 'Onboarding' ? 'secondary' : 'outline'),
  },
]

export function PeopleList({ rows }: { rows: PersonRow[] }) {
  const router = useRouter()
  const [search, setSearch] = React.useState('')
  const [sort, setSort] = React.useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' })

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    const base = q
      ? rows.filter((r) => [r.name, r.title, r.email, r.reportsTo].some((v) => v.toLowerCase().includes(q)))
      : rows
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...base].sort((a, b) => {
      const key = sort.key as keyof PersonRow
      return String(a[key]).localeCompare(String(b[key])) * dir
    })
  }, [rows, search, sort])

  return (
    <RecordList
      columns={COLUMNS}
      rows={filtered}
      getRowId={(row) => row.id}
      search={{ value: search, onChange: setSearch, placeholder: 'Search people…' }}
      sort={sort}
      onSortChange={(key) =>
        setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
      }
      linkRender={({ href, children, className }) => (
        <Link href={href} className={className}>
          {children}
        </Link>
      )}
      onRowClick={(row) => router.push(`/people?person=${row.id}`, { scroll: false })}
      empty={{
        title: 'Nobody here yet',
        description: 'Add your human team, then hire your first hand from a role pack.',
      }}
    />
  )
}
