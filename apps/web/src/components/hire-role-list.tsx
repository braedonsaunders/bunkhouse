'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { RecordList, type RecordColumn } from '@appkit/ui'

export type RoleRow = {
  slug: string
  title: string
  pitch: string
  duties: number
  procedures: number
  salaryUsd: number
  statusLabel: 'Reviewing' | 'Available'
}

const COLUMNS: RecordColumn<RoleRow>[] = [
  { key: 'title', label: 'Role', kind: 'reference', sortable: true, href: (row) => `/people/hire?role=${row.slug}` },
  { key: 'pitch', label: 'What they do' },
  { key: 'duties', label: 'Duties', align: 'right', sortable: true },
  { key: 'procedures', label: 'Procedures', align: 'right', sortable: true },
  {
    key: 'salaryUsd',
    label: 'Salary',
    kind: 'amount',
    align: 'right',
    sortable: true,
    format: (value) => `$${value as number}/mo`,
  },
  {
    key: 'statusLabel',
    label: 'Status',
    kind: 'status',
    statusVariant: (value) => (value === 'Reviewing' ? 'default' : 'outline'),
  },
]

export function HireRoleList({ rows }: { rows: RoleRow[] }) {
  const router = useRouter()
  const [sort, setSort] = React.useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'title', dir: 'asc' })

  const sorted = React.useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const key = sort.key as keyof RoleRow
      const av = a[key]
      const bv = b[key]
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv)) * dir
    })
  }, [rows, sort])

  return (
    <RecordList
      columns={COLUMNS}
      rows={sorted}
      getRowId={(row) => row.slug}
      sort={sort}
      onSortChange={(key) =>
        setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
      }
      linkRender={({ href, children, className }) => (
        <Link href={href} className={className}>
          {children}
        </Link>
      )}
      onRowClick={(row) => router.push(`/people/hire?role=${row.slug}`)}
      empty={{ title: 'No roles installed', description: 'Role packs define the jobs hands can be hired into.' }}
    />
  )
}
