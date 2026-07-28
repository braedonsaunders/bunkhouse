'use client'

import * as React from 'react'
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
import { addRevision, createProcedure, setProcedureAssignment, setProcedureStatus } from '../app/knowledge/procedure-actions'
import { MarkdownEditor } from './markdown-editor'

export type ProcedureRow = {
  id: string
  slug: string
  title: string
  status: 'draft' | 'active' | 'retired'
  version: number
  appliesTo: string
  updatedAt: string
  body: string
  revisions: { version: number; body: string; changeNote: string; createdAt: string }[]
  assignment: { everyone?: boolean; rolePacks?: string[]; personIds?: string[] }
}

export type AssignOption = { value: string; label: string }

const COLUMNS: RecordColumn<ProcedureRow>[] = [
  { key: 'title', label: 'Procedure', sortable: true },
  {
    key: 'status',
    label: 'Status',
    kind: 'status',
    sortable: true,
    statusVariant: (value) => (value === 'active' ? 'default' : value === 'retired' ? 'outline' : 'secondary'),
  },
  { key: 'version', label: 'Version', align: 'right', sortable: true, format: (v) => `v${v as number}` },
  { key: 'appliesTo', label: 'Applies to' },
  { key: 'updatedAt', label: 'Updated', sortable: true },
]

function AssignmentFields({
  rolePackOptions,
  handOptions,
  current,
}: {
  rolePackOptions: AssignOption[]
  handOptions: AssignOption[]
  current?: ProcedureRow['assignment']
}) {
  const [everyone, setEveryone] = React.useState(current?.everyone ?? false)
  const [rolePacks, setRolePacks] = React.useState<string[]>(current?.rolePacks ?? [])
  const [personIds, setPersonIds] = React.useState<string[]>(current?.personIds ?? [])
  const toggle = (list: string[], set: (v: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value])

  return (
    <div className="space-y-2">
      <input type="hidden" name="everyone" value={everyone ? 'on' : ''} />
      <input type="hidden" name="rolePacks" value={rolePacks.join(',')} />
      <input type="hidden" name="personIds" value={personIds.join(',')} />
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          onClick={() => setEveryone((v) => !v)}
          className={
            everyone
              ? 'rounded-md border border-primary bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary'
              : 'rounded-md border border-border px-2.5 py-1 text-xs text-fg-muted hover:border-primary/50'
          }
        >
          Everyone
        </button>
        {!everyone
          ? rolePackOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => toggle(rolePacks, setRolePacks, option.value)}
                className={
                  rolePacks.includes(option.value)
                    ? 'rounded-md border border-primary bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary'
                    : 'rounded-md border border-border px-2.5 py-1 text-xs text-fg-muted hover:border-primary/50'
                }
              >
                {option.label}
              </button>
            ))
          : null}
        {!everyone
          ? handOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => toggle(personIds, setPersonIds, option.value)}
                className={
                  personIds.includes(option.value)
                    ? 'rounded-md border border-primary bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary'
                    : 'rounded-md border border-border px-2.5 py-1 text-xs text-fg-muted hover:border-primary/50'
                }
              >
                {option.label}
              </button>
            ))
          : null}
      </div>
    </div>
  )
}

export function ProceduresView({
  rows,
  rolePackOptions,
  handOptions,
}: {
  rows: ProcedureRow[]
  rolePackOptions: AssignOption[]
  handOptions: AssignOption[]
}) {
  const [selected, setSelected] = React.useState<ProcedureRow | null>(null)
  const [creating, setCreating] = React.useState(false)
  const [busy, startBusy] = React.useTransition()
  const [error, setError] = React.useState<string | null>(null)

  const act = (action: (form: FormData) => Promise<void>, form: FormData, close = false) =>
    startBusy(async () => {
      setError(null)
      try {
        await action(form)
        if (close) {
          setSelected(null)
          setCreating(false)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })

  return (
    <>
      <RecordList
        columns={COLUMNS}
        rows={rows}
        getRowId={(row) => row.id}
        onRowClick={(row) => {
          setError(null)
          setSelected(row)
        }}
        toolbarActions={
          <Button size="sm" onClick={() => setCreating(true)}>
            New procedure
          </Button>
        }
        empty={{
          title: 'No procedures yet',
          description: 'Write your first SOP — every hand it binds to will follow and cite it.',
        }}
      />

      <Drawer
        open={creating}
        onClose={() => setCreating(false)}
        title="New procedure"
        description="Versioned company doctrine — hands cite it when their work follows it."
        size="lg"
      >
        <form action={(form) => act(createProcedure, form, true)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="proc-title">Title</Label>
            <Input id="proc-title" name="title" placeholder="Refund and exception handling" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="proc-body">Procedure</Label>
            <MarkdownEditor name="body" placeholder="Write it the way you'd write it for a new hire." minHeight="240px" />
          </div>
          <div className="space-y-2">
            <Label>Applies to</Label>
            <AssignmentFields rolePackOptions={rolePackOptions} handOptions={handOptions} />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Create procedure'}
          </Button>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </form>
      </Drawer>

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? selected.title : ''}
        description={selected ? `v${selected.version} · ${selected.appliesTo}` : undefined}
        size="lg"
      >
        {selected ? (
          <div className="space-y-6">
            <div className="flex items-center gap-2">
              <Badge variant={selected.status === 'active' ? 'default' : 'outline'}>{selected.status}</Badge>
              <form action={(form) => act(setProcedureStatus, form)}>
                <input type="hidden" name="procedureId" value={selected.id} />
                <input type="hidden" name="status" value={selected.status === 'active' ? 'retired' : 'active'} />
                <Button type="submit" variant="outline" size="sm" disabled={busy}>
                  {selected.status === 'active' ? 'Retire' : 'Reactivate'}
                </Button>
              </form>
            </div>

            <div className="rounded-md border border-border p-3">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-muted">Current (v{selected.version})</p>
              <p className="whitespace-pre-wrap text-sm">{selected.body}</p>
            </div>

            <form action={(form) => act(setProcedureAssignment, form)} className="space-y-2">
              <input type="hidden" name="procedureId" value={selected.id} />
              <Label>Applies to</Label>
              <AssignmentFields rolePackOptions={rolePackOptions} handOptions={handOptions} current={selected.assignment} />
              <Button type="submit" variant="outline" size="sm" disabled={busy}>
                Save assignment
              </Button>
            </form>

            <form action={(form) => act(addRevision, form, true)} className="space-y-2">
              <input type="hidden" name="procedureId" value={selected.id} />
              <Label htmlFor="rev-body">New revision</Label>
              <MarkdownEditor name="body" defaultValue={selected.body} minHeight="200px" />
              <Input name="changeNote" placeholder="What changed and why (audit note)" />
              <Button type="submit" variant="outline" size="sm" disabled={busy}>
                Publish v{selected.version + 1}
              </Button>
            </form>

            {selected.revisions.length > 1 ? (
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">History</p>
                {selected.revisions.map((rev) => (
                  <div key={rev.version} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                    <span>
                      v{rev.version}
                      {rev.changeNote ? <span className="text-fg-muted"> — {rev.changeNote}</span> : null}
                    </span>
                    <span className="text-xs text-fg-muted">{rev.createdAt}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {error ? <p className="text-sm text-danger">{error}</p> : null}
          </div>
        ) : null}
      </Drawer>
    </>
  )
}
