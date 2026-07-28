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
  type RecordColumn,
} from '@appkit/ui'
import {
  addMemoryNote,
  deleteMemoryNote,
  promoteNoteAction,
  togglePinNote,
  updateMemoryNote,
} from '../app/people/actions'
import { addCompanyNote, decideMemoryProposal } from '../app/knowledge/actions'
import { MarkdownEditor } from './markdown-editor'

export type NoteRow = {
  id: string
  slug: string
  kind: 'fact' | 'episode' | 'procedure' | 'reflection'
  title: string
  body: string
  importance: number
  pinned: boolean
  author: string
  updatedAt: string
}

const KIND_VARIANT = (value: string) =>
  value === 'procedure' ? ('default' as const) : value === 'reflection' ? ('secondary' as const) : ('outline' as const)

const COLUMNS: RecordColumn<NoteRow>[] = [
  { key: 'title', label: 'Note', sortable: true },
  { key: 'kind', label: 'Kind', kind: 'status', sortable: true, statusVariant: KIND_VARIANT },
  { key: 'importance', label: 'Importance', align: 'right', sortable: true },
  {
    key: 'pinned',
    label: 'Pinned',
    render: (row) => (row.pinned ? <Badge>pinned</Badge> : <span className="text-fg-subtle">—</span>),
  },
  { key: 'author', label: 'By', sortable: true },
  { key: 'updatedAt', label: 'Updated', sortable: true },
]

/**
 * The Logbook list: one component for a hand's memory and for company
 * knowledge — RecordList rows, drawers for the record and for authoring.
 */
export function NotesView({
  rows,
  scope,
  personId,
}: {
  rows: NoteRow[]
  scope: 'hand' | 'company'
  personId?: string
}) {
  const [selected, setSelected] = React.useState<NoteRow | null>(null)
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

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
            New note
          </Button>
        }
        empty={{
          title: scope === 'company' ? 'No company knowledge yet' : 'Nothing remembered yet',
          description:
            scope === 'company'
              ? 'Write the facts every hand should share, or approve a proposal below.'
              : 'Notes appear here as this hand works — or add one yourself.',
        }}
      />

      <Drawer
        open={creating}
        onClose={() => setCreating(false)}
        title="New note"
        description="Markdown; link other notes with [[slug]]. Facts stay true until superseded; episodes fade; procedures bind."
        size="md"
      >
        <form
          action={(form) => {
            if (personId) form.set('personId', personId)
            act(scope === 'company' ? addCompanyNote : addMemoryNote, form, true)
          }}
          className="space-y-4"
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="note-kind">Kind</Label>
              <Select id="note-kind" name="kind" defaultValue="fact">
                <option value="fact">Fact</option>
                <option value="episode">Episode</option>
                <option value="procedure">Procedure</option>
                <option value="reflection">Reflection</option>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="note-importance">Importance (1–5)</Label>
              <Input id="note-importance" name="importance" type="number" min={1} max={5} defaultValue={3} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="note-title">Title</Label>
            <Input id="note-title" name="title" placeholder="Preferred vendor for tires" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="note-body">Note</Label>
            <MarkdownEditor name="body" placeholder="Something worth remembering. Link with [[slug]]." />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save note'}
          </Button>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </form>
      </Drawer>

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.title ?? ''}
        description={selected ? `[[${selected.slug}]] · by ${selected.author} · updated ${selected.updatedAt}` : undefined}
        size="lg"
      >
        {selected ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={KIND_VARIANT(selected.kind)}>{selected.kind}</Badge>
              <Badge variant="outline">importance {selected.importance}</Badge>
              {selected.pinned ? <Badge>pinned</Badge> : null}
            </div>

            <form action={(form) => act(updateMemoryNote, form, true)} className="space-y-3">
              <input type="hidden" name="memoryId" value={selected.id} />
              <div className="space-y-2">
                <Label htmlFor="edit-title">Title</Label>
                <Input id="edit-title" name="title" defaultValue={selected.title} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-body">Note</Label>
                <MarkdownEditor name="body" defaultValue={selected.body} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-importance">Importance (1–5)</Label>
                <Input id="edit-importance" name="importance" type="number" min={1} max={5} defaultValue={selected.importance} className="w-28" />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" disabled={busy}>
                  Save correction
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    const form = new FormData()
                    form.set('memoryId', selected.id)
                    form.set('pinned', selected.pinned ? 'false' : 'true')
                    act(togglePinNote, form, true)
                  }}
                >
                  {selected.pinned ? 'Unpin' : 'Pin to prompt'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    const form = new FormData()
                    form.set('memoryId', selected.id)
                    act(deleteMemoryNote, form, true)
                  }}
                >
                  Forget
                </Button>
              </div>
              <p className="text-xs text-fg-muted">
                Corrections keep history; forgetting closes the note&apos;s validity window — nothing is deleted.
              </p>
            </form>

            {scope === 'hand' ? (
              <form
                action={(form) => {
                  form.set('memoryId', selected.id)
                  act(promoteNoteAction, form, true)
                }}
                className="space-y-2 rounded-md border border-dashed border-border p-3"
              >
                <Label htmlFor="promote-rationale">Propose for company knowledge</Label>
                <Input id="promote-rationale" name="rationale" placeholder="Why the whole company should know this" />
                <Button type="submit" variant="outline" size="sm" disabled={busy}>
                  Send proposal
                </Button>
              </form>
            ) : null}
            {error ? <p className="text-sm text-danger">{error}</p> : null}
          </div>
        ) : null}
      </Drawer>
    </>
  )
}

export type ProposalRow = {
  id: string
  kind: string
  title: string
  body: string
  rationale: string
  from: string
  createdAt: string
}

const PROPOSAL_COLUMNS: RecordColumn<ProposalRow>[] = [
  { key: 'title', label: 'Proposal', sortable: true },
  { key: 'kind', label: 'Kind', kind: 'status', statusVariant: () => 'secondary' },
  { key: 'from', label: 'From', sortable: true },
  { key: 'createdAt', label: 'Proposed', sortable: true },
]

/** The approval boundary for company knowledge, as a list + decision drawer. */
export function ProposalsView({ rows }: { rows: ProposalRow[] }) {
  const [selected, setSelected] = React.useState<ProposalRow | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  const decide = (decision: 'approve' | 'reject') =>
    startBusy(async () => {
      setError(null)
      const form = new FormData()
      form.set('proposalId', selected!.id)
      form.set('decision', decision)
      try {
        await decideMemoryProposal(form)
        setSelected(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })

  return (
    <>
      <RecordList
        columns={PROPOSAL_COLUMNS}
        rows={rows}
        getRowId={(row) => row.id}
        onRowClick={(row) => setSelected(row)}
        empty={{ title: 'No open proposals', description: 'Hands nominate knowledge here; you decide what crosses.' }}
      />
      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? `Proposal — ${selected.title}` : ''}
        description={selected ? `${selected.kind} · from ${selected.from} · ${selected.createdAt}` : undefined}
        size="md"
      >
        {selected ? (
          <div className="space-y-4">
            <div className="rounded-md border border-border p-3 text-sm whitespace-pre-wrap">{selected.body}</div>
            <p className="text-sm text-fg-muted">Rationale: {selected.rationale}</p>
            <div className="flex items-center gap-2">
              <Button onClick={() => decide('approve')} disabled={busy}>
                {selected.kind === 'promote'
                  ? 'Approve into company knowledge'
                  : selected.kind === 'supersede'
                    ? 'Approve — supersede the old note'
                    : 'Approve this change'}
              </Button>
              <Button variant="outline" onClick={() => decide('reject')} disabled={busy}>
                Reject
              </Button>
            </div>
            {error ? <p className="text-sm text-danger">{error}</p> : null}
          </div>
        ) : null}
      </Drawer>
    </>
  )
}
