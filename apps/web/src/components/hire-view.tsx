'use client'

import * as React from 'react'
import Link from 'next/link'
import {
  Badge,
  Button,
  Drawer,
  Input,
  Label,
  RecordList,
  Select,
  Textarea,
  type RecordColumn,
} from '@appkit/ui'
import { hireHand } from '../app/people/actions'

export type RoleRow = {
  slug: string
  title: string
  pitch: string
  description: string
  duties: { title: string; cron: string }[]
  procedures: { title: string }[]
  salaryUsd: number
  defaultBio: string
}

export type RosterOption = { id: string; name: string; title: string }

const COLUMNS: RecordColumn<RoleRow>[] = [
  { key: 'title', label: 'Role', kind: 'reference', sortable: true, href: (row) => `/people/hire?role=${row.slug}` },
  { key: 'pitch', label: 'What they do' },
  {
    key: 'duties',
    label: 'Duties',
    align: 'right',
    render: (row) => <span className="tabular-nums">{row.duties.length}</span>,
  },
  {
    key: 'procedures',
    label: 'Procedures',
    align: 'right',
    render: (row) => <span className="tabular-nums">{row.procedures.length}</span>,
  },
  {
    key: 'salaryUsd',
    label: 'Salary',
    kind: 'amount',
    sortable: true,
    format: (value) => `$${value as number}/mo`,
  },
]

export function HireView({ roles, roster }: { roles: RoleRow[]; roster: RosterOption[] }) {
  const [selected, setSelected] = React.useState<RoleRow | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [hiring, startHiring] = React.useTransition()

  const submit = (form: FormData) =>
    startHiring(async () => {
      setError(null)
      try {
        await hireHand(form)
      } catch (err) {
        // Server-action redirects surface as a special error Next handles;
        // anything that reaches here is a real failure.
        if (err && typeof err === 'object' && 'digest' in err) throw err
        setError(err instanceof Error ? err.message : String(err))
      }
    })

  return (
    <>
      <RecordList
        columns={COLUMNS}
        rows={roles}
        getRowId={(row) => row.slug}
        linkRender={({ href: _href, children, className }) => <span className={className}>{children}</span>}
        onRowClick={(row) => {
          setError(null)
          setSelected(row)
        }}
        empty={{ title: 'No roles installed', description: 'Role packs define the jobs hands can be hired into.' }}
      />

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? `Hire — ${selected.title}` : ''}
        description={selected?.pitch}
        size="lg"
      >
        {selected ? (
          <div className="space-y-6">
            <p className="text-sm text-fg-muted">{selected.description}</p>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Standing duties</p>
                <ul className="space-y-1 text-sm">
                  {selected.duties.map((duty) => (
                    <li key={duty.title} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                      <span>{duty.title}</span>
                      <Badge variant="outline">{duty.cron}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Binding procedures</p>
                <ul className="space-y-1 text-sm">
                  {selected.procedures.map((procedure) => (
                    <li key={procedure.title} className="rounded-md border border-border px-3 py-2">
                      {procedure.title}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <form action={submit} className="grid gap-4 sm:grid-cols-2">
              <input type="hidden" name="rolePack" value={selected.slug} />
              <div className="space-y-2">
                <Label htmlFor="hire-name">Name</Label>
                <Input id="hire-name" name="name" placeholder="Dana Reeves" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="hire-email">Email address on your domain</Label>
                <Input id="hire-email" name="email" type="email" placeholder="dana@yourcompany.com" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="hire-salary">Monthly salary (USD token budget)</Label>
                <Input id="hire-salary" name="salaryUsd" type="number" min="1" step="1" defaultValue={selected.salaryUsd} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="hire-reports">Reports to</Label>
                <Select id="hire-reports" name="reportsToId" defaultValue="">
                  <option value="">— Nobody yet —</option>
                  {roster.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name} — {person.title}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="hire-bio">Personality (the role has a good default)</Label>
                <Textarea id="hire-bio" name="bio" rows={3} defaultValue={selected.defaultBio} />
              </div>
              <div className="sm:col-span-2 flex items-center gap-3">
                <Button type="submit" disabled={hiring}>
                  {hiring ? 'Extending offer…' : 'Extend the offer'}
                </Button>
                <span className="text-xs text-fg-muted">They start onboarding immediately.</span>
              </div>
              {error ? <p className="sm:col-span-2 text-sm text-danger">{error}</p> : null}
            </form>
          </div>
        ) : null}
      </Drawer>
    </>
  )
}
