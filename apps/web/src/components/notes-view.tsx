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
  SubtabNav,
  type RecordColumn,
} from '@appkit/ui'
import type { ResourceAssignment } from '../db/schema'
import {
  addMemoryNote,
  deleteMemoryNote,
  promoteNoteAction,
  togglePinNote,
  updateMemoryNote,
} from '../app/organization/actions'
import { addCompanyNote, decideMemoryProposal, setCompanyNoteAssignment } from '../app/resources/actions'
import { AssignmentFields, type AssignOption } from './procedures-view'
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
  /** Company knowledge only — an agent's own note reaches the agent it belongs to. */
  appliesTo?: string
  assignment?: ResourceAssignment
}

const KIND_VARIANT = (value: string) =>
  value === 'procedure' ? ('default' as const) : value === 'reflection' ? ('secondary' as const) : ('outline' as const)

const columnsFor = (scope: 'agent' | 'company'): RecordColumn<NoteRow>[] => [
  { key: 'title', label: 'Note', sortable: true },
  { key: 'kind', label: 'Kind', kind: 'status', sortable: true, statusVariant: KIND_VARIANT },
  { key: 'importance', label: 'Importance', align: 'right', sortable: true },
  {
    key: 'pinned',
    label: 'Pinned',
    render: (row) => (row.pinned ? <Badge>pinned</Badge> : <span className="text-fg-subtle">—</span>),
  },
  ...(scope === 'company' ? [{ key: 'appliesTo', label: 'Applies to' } as RecordColumn<NoteRow>] : []),
  { key: 'author', label: 'By', sortable: true },
  { key: 'updatedAt', label: 'Updated', sortable: true },
]

/**
 * The Logbook list: one component for an agent's memory and for company
 * knowledge — RecordList rows, drawers for the record and for authoring.
 */
export function NotesView({
  rows,
  scope,
  personId,
  roleOptions = [],
  agentOptions = [],
}: {
  rows: NoteRow[]
  scope: 'agent' | 'company'
  personId?: string
  /** Company knowledge only: who a note can be given to. */
  roleOptions?: AssignOption[]
  agentOptions?: AssignOption[]
}) {
  const [selected, setSelected] = React.useState<NoteRow | null>(null)
  const [tab, setTab] = React.useState('note')
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
        columns={columnsFor(scope)}
        rows={rows}
        getRowId={(row) => row.id}
        onRowClick={(row) => {
          setError(null)
          setTab('note')
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
              ? 'Write the facts every agent should share, or approve a proposal below.'
              : 'Notes appear here as this agent works — or add one yourself.',
        }}
      />

      <Drawer
        open={creating}
        onClose={() => setCreating(false)}
        title="New note"
        description="Markdown; link other notes with [[slug]]. Facts stay true until superseded; episodes fade; procedures bind."
        size="2xl"
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
          {scope === 'company' ? (
            <div className="space-y-2">
              <Label>Applies to</Label>
              <AssignmentFields roleOptions={roleOptions} agentOptions={agentOptions} defaultEveryone />
              <p className="text-xs text-fg-muted">
                Narrow it to a role and only agents holding that role carry it in their prompt.
              </p>
            </div>
          ) : null}
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
        size="2xl"
      >
        {selected ? (
          <div className="space-y-5">
            <SubtabNav
              tabs={[
                { key: 'note', label: 'Note' },
                scope === 'company'
                  ? { key: 'applies', label: 'Applies to' }
                  : { key: 'propose', label: 'Propose' },
              ]}
              active={tab}
              onSelect={(key) => {
                setTab(key)
                setError(null)
              }}
              ariaLabel="Note sections"
            />

            <div className={tab === 'note' ? 'flex flex-wrap items-center gap-2' : 'hidden'}>
              <Badge variant={KIND_VARIANT(selected.kind)}>{selected.kind}</Badge>
              <Badge variant="outline">importance {selected.importance}</Badge>
              {selected.pinned ? <Badge>pinned</Badge> : null}
            </div>

            <form
              action={(form) => act(updateMemoryNote, form, true)}
              className={tab === 'note' ? 'space-y-3' : 'hidden'}
            >
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

            {scope === 'agent' && tab === 'propose' ? (
              <form
                action={(form) => {
                  form.set('memoryId', selected.id)
                  act(promoteNoteAction, form, true)
                }}
                className="space-y-2"
              >
                <Label htmlFor="promote-rationale">Propose for company knowledge</Label>
                <Input id="promote-rationale" name="rationale" placeholder="Why the whole company should know this" />
                <Button type="submit" variant="outline" size="sm" disabled={busy}>
                  Send proposal
                </Button>
                <p className="text-xs text-fg-muted">
                  A human decides whether it crosses into company knowledge — and which roles it reaches once it does.
                </p>
              </form>
            ) : null}

            {scope === 'company' && tab === 'applies' ? (
              <form
                action={(form) => {
                  form.set('memoryId', selected.id)
                  act(setCompanyNoteAssignment, form)
                }}
                className="space-y-3"
              >
                <div className="space-y-2">
                  <Label>Who carries this</Label>
                  <AssignmentFields
                    key={selected.id}
                    roleOptions={roleOptions}
                    agentOptions={agentOptions}
                    {...(selected.assignment ? { current: selected.assignment } : {})}
                  />
                </div>
                <Button type="submit" variant="outline" size="sm" disabled={busy}>
                  Save assignment
                </Button>
                <p className="text-xs text-fg-muted">
                  Company knowledge rides in the prompt of every agent it applies to; narrowing it keeps a role&apos;s
                  context about that role.
                </p>
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
  status: 'open' | 'auto_applied'
  decidedAt: string | null
  /** True for the monthly housekeeping pass (lib/consolidation.ts gardenerPass) —
   *  rendered as "Housekeeping suggestion", never the internal job name. */
  housekeeping: boolean
  /** The live notes this proposal reads against, for a before/after diff. */
  refs: { id: string; slug: string; title: string; body: string }[]
}

const HOUSEKEEPING_KIND_LABEL: Record<string, string> = {
  merge: 'Merge duplicate notes',
  expire: 'Retire stale note',
  edit: 'Resolve contradiction',
}

const KIND_LABEL = (row: ProposalRow) => (row.housekeeping ? (HOUSEKEEPING_KIND_LABEL[row.kind] ?? 'Housekeeping') : row.kind)

const PROPOSAL_COLUMNS: RecordColumn<ProposalRow>[] = [
  { key: 'title', label: 'Proposal', sortable: true },
  {
    key: 'kind',
    label: 'Type',
    render: (row) => <Badge variant={row.housekeeping ? 'secondary' : 'outline'}>{KIND_LABEL(row)}</Badge>,
  },
  {
    key: 'status',
    label: 'Status',
    render: (row) =>
      row.status === 'auto_applied' ? (
        <Badge variant="secondary">Applied automatically</Badge>
      ) : (
        <Badge variant="outline">Needs review</Badge>
      ),
  },
  { key: 'from', label: 'From', sortable: true },
  { key: 'createdAt', label: 'Proposed', sortable: true },
]

/** The approval boundary for company knowledge, as a list + decision drawer.
 *  Renders agent nominations, journal/reflection consolidator proposals, and
 *  the monthly housekeeping pass's merge/expire/contradiction suggestions —
 *  the last group gets a real before/after diff since "here's the new text"
 *  alone doesn't explain what it replaces. */
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
        empty={{
          title: 'No knowledge changes pending',
          description:
            'Agents nominate knowledge here, and the monthly housekeeping pass flags duplicate or conflicting notes — you decide what crosses.',
        }}
      />
      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? `${selected.housekeeping ? 'Housekeeping suggestion' : 'Proposal'} — ${selected.title}` : ''}
        description={selected ? `${KIND_LABEL(selected)} · from ${selected.from} · ${selected.createdAt}` : undefined}
        size="2xl"
      >
        {selected ? (
          <div className="space-y-4">
            {selected.refs.length > 0 ? (
              <div className="space-y-3">
                <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Current</p>
                {selected.refs.map((ref) => (
                  <div key={ref.id} className="rounded-md border border-border p-3 text-sm">
                    <p className="mb-1 font-medium">
                      [[{ref.slug}]] · {ref.title}
                    </p>
                    <p className="whitespace-pre-wrap text-fg-muted">{ref.body}</p>
                  </div>
                ))}
                {selected.kind === 'expire' ? (
                  <p className="text-sm text-fg-muted">This note will be retired — no successor note is created.</p>
                ) : (
                  <>
                    <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Proposed</p>
                    <div className="rounded-md border border-border p-3 text-sm whitespace-pre-wrap">{selected.body}</div>
                  </>
                )}
              </div>
            ) : (
              <div className="rounded-md border border-border p-3 text-sm whitespace-pre-wrap">{selected.body}</div>
            )}
            <p className="text-sm text-fg-muted">Rationale: {selected.rationale}</p>
            {selected.status === 'auto_applied' ? (
              <p className="text-sm text-fg-muted">
                Applied automatically{selected.decidedAt ? ` on ${selected.decidedAt}` : ''} — the two notes were word-for-word
                identical, so no review was needed.
              </p>
            ) : (
              <div className="flex items-center gap-2">
                <Button onClick={() => decide('approve')} disabled={busy}>
                  {selected.kind === 'promote'
                    ? 'Approve into company knowledge'
                    : selected.kind === 'supersede'
                      ? 'Approve — supersede the old note'
                      : selected.kind === 'merge'
                        ? 'Approve — merge into one note'
                        : selected.kind === 'expire'
                          ? 'Approve — retire this note'
                          : selected.housekeeping
                            ? 'Approve — resolve contradiction'
                            : 'Approve this change'}
                </Button>
                <Button variant="outline" onClick={() => decide('reject')} disabled={busy}>
                  Reject
                </Button>
              </div>
            )}
            {error ? <p className="text-sm text-danger">{error}</p> : null}
          </div>
        ) : null}
      </Drawer>
    </>
  )
}
