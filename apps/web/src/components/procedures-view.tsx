'use client'

import * as React from 'react'
import {
  Badge,
  Button,
  Drawer,
  Input,
  Label,
  RecordList,
  SubtabNav,
  type RecordColumn,
} from '@appkit/ui'
import type { ProcedureContent } from '../db/schema'
import { addRevision, createProcedure, setProcedureAssignment, setProcedureStatus } from '../app/knowledge/procedure-actions'
import { contentFromLegacyBody } from '../lib/procedures'
import { ProcedureEditor, emptyDraft } from './procedure-editor'
import { ProcedureReader } from './procedure-reader'

export type ProcedureRevision = {
  version: number
  body: string
  content: ProcedureContent | null
  changeNote: string
  createdAt: string
}

export type ProcedureRow = {
  id: string
  slug: string
  title: string
  status: 'draft' | 'active' | 'retired'
  version: number
  appliesTo: string
  updatedAt: string
  body: string
  content: ProcedureContent | null
  steps: number
  revisions: ProcedureRevision[]
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
  { key: 'steps', label: 'Steps', align: 'right', sortable: true },
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


type Mode = { kind: 'read' } | { kind: 'edit'; draft: ProcedureContent }

/**
 * The procedure workspace: a list, an authoring flyout, and a record flyout
 * split into subtabs. Editing happens in place on the Procedure tab and
 * publishes the next version — there is no second editor stacked below the
 * one you are reading.
 */
export function ProceduresView({
  rows,
  rolePackOptions,
  handOptions,
}: {
  rows: ProcedureRow[]
  rolePackOptions: AssignOption[]
  handOptions: AssignOption[]
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [tab, setTab] = React.useState('procedure')
  const [mode, setMode] = React.useState<Mode>({ kind: 'read' })
  const [viewingVersion, setViewingVersion] = React.useState<number | null>(null)
  /**
   * Whether the authoring flyout is open is its own flag, never derived from the
   * draft: React resets a form once its action resolves, and the rich-text
   * editors answer that reset with a change event. Deriving `open` from the
   * draft would let that late event reopen a flyout the operator just finished.
   */
  const [creating, setCreating] = React.useState(false)
  const [draft, setDraft] = React.useState<ProcedureContent>(emptyDraft)
  const [authoringKey, setAuthoringKey] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const selected = rows.find((row) => row.id === selectedId) ?? null
  const shown = selected
    ? (selected.revisions.find((rev) => rev.version === viewingVersion) ?? {
        version: selected.version,
        body: selected.body,
        content: selected.content,
        changeNote: '',
        createdAt: selected.updatedAt,
      })
    : null

  /**
   * Run a server action as the form's own action and surface its outcome.
   * Deliberately not wrapped in a transition: awaiting a server action inside
   * `startTransition` from a form action leaves the transition pending forever
   * here, so the button never comes back from its saving state.
   */
  const act = async (action: (form: FormData) => Promise<void>, form: FormData, done?: () => void) => {
    setError(null)
    setBusy(true)
    try {
      await action(form)
      done?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const openAuthoring = () => {
    setError(null)
    setDraft(emptyDraft())
    setAuthoringKey((n) => n + 1)
    setCreating(true)
  }

  const closeAuthoring = () => {
    setCreating(false)
    setAuthoringKey((n) => n + 1)
  }

  const openRecord = (row: ProcedureRow) => {
    setError(null)
    setSelectedId(row.id)
    setTab('procedure')
    setMode({ kind: 'read' })
    setViewingVersion(null)
  }

  const closeRecord = () => {
    setSelectedId(null)
    setMode({ kind: 'read' })
  }

  const startEditing = () => {
    if (!selected) return
    setError(null)
    setViewingVersion(null)
    setMode({ kind: 'edit', draft: selected.content ?? contentFromLegacyBody(selected.body) })
  }

  return (
    <>
      <RecordList
        columns={COLUMNS}
        rows={rows}
        getRowId={(row) => row.id}
        onRowClick={openRecord}
        toolbarActions={
          <Button size="sm" onClick={openAuthoring}>
            New procedure
          </Button>
        }
        empty={{
          title: 'No procedures yet',
          description: 'Write your first SOP — every hand it binds to will follow it step by step and cite it.',
        }}
      />

      {/* Authoring */}
      <Drawer
        open={creating}
        onClose={closeAuthoring}
        title="New procedure"
        description="Versioned company doctrine — hands follow these steps and cite the version they followed."
        size="2xl"
      >
        {/*
          Remounted per authoring session: the key retires the rich-text editors
          along with the flyout, so a finished draft never bleeds into the next
          one and a post-submit reset lands on a form that is already gone.
        */}
        <form
          key={authoringKey}
          action={(form) => act(createProcedure, form, closeAuthoring)}
          className="space-y-6"
        >
          <div className="space-y-2">
            <Label htmlFor="proc-title">Title</Label>
            <Input id="proc-title" name="title" placeholder="Refund and exception handling" required />
          </div>

          <ProcedureEditor name="content" value={draft} onChange={setDraft} />

          <div className="space-y-2">
            <Label>Applies to</Label>
            <AssignmentFields rolePackOptions={rolePackOptions} handOptions={handOptions} />
          </div>

          <div className="flex items-center gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Create procedure'}
            </Button>
            <Button type="button" variant="outline" onClick={closeAuthoring}>
              Cancel
            </Button>
          </div>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </form>
      </Drawer>

      {/* Record */}
      <Drawer
        open={selected !== null}
        onClose={closeRecord}
        title={
          selected ? (
            <span className="flex items-center gap-2">
              {selected.title}
              <Badge variant={selected.status === 'active' ? 'default' : 'outline'}>{selected.status}</Badge>
            </span>
          ) : (
            ''
          )
        }
        description={selected ? `v${selected.version} · applies to ${selected.appliesTo}` : undefined}
        headerActions={
          selected ? (
            <form action={(form) => act(setProcedureStatus, form)}>
              <input type="hidden" name="procedureId" value={selected.id} />
              <input type="hidden" name="status" value={selected.status === 'active' ? 'retired' : 'active'} />
              <Button type="submit" variant="outline" size="sm" disabled={busy}>
                {selected.status === 'active' ? 'Retire' : 'Reactivate'}
              </Button>
            </form>
          ) : undefined
        }
        size="2xl"
      >
        {selected && shown ? (
          <div className="space-y-4">
            <SubtabNav
              tabs={[
                { key: 'procedure', label: 'Procedure', count: selected.content?.steps.length ?? 0 },
                { key: 'applies', label: 'Applies to' },
                { key: 'history', label: 'History', count: selected.revisions.length },
              ]}
              active={tab}
              onSelect={(key) => {
                setTab(key)
                setError(null)
                if (key !== 'procedure') setMode({ kind: 'read' })
              }}
              ariaLabel="Procedure sections"
            />

            {tab === 'procedure' && mode.kind === 'read' ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm text-fg-muted">
                    {viewingVersion === null ? (
                      <>
                        <Badge variant="secondary">v{selected.version}</Badge> in force now
                      </>
                    ) : (
                      <>
                        <Badge variant="outline">v{shown.version}</Badge> superseded — {shown.createdAt}
                      </>
                    )}
                  </span>
                  {/* Editing always starts from the version in force — offer it only there. */}
                  {viewingVersion === null ? (
                    <Button size="sm" onClick={startEditing}>
                      Edit
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => setViewingVersion(null)}>
                      Back to current
                    </Button>
                  )}
                </div>
                <ProcedureReader content={shown.content} body={shown.body} />
              </div>
            ) : null}

            {tab === 'procedure' && mode.kind === 'edit' ? (
              <form
                action={(form) =>
                  act(addRevision, form, () => {
                    setMode({ kind: 'read' })
                  })
                }
                className="space-y-5"
              >
                <input type="hidden" name="procedureId" value={selected.id} />
                {selected.content === null ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-fg-muted">
                    This procedure was written as one block. Its text is kept below as the first step — split it into
                    the steps a hand should work through.
                  </p>
                ) : null}

                <ProcedureEditor
                  name="content"
                  value={mode.draft}
                  onChange={(next) => setMode({ kind: 'edit', draft: next })}
                />

                <div className="sticky bottom-0 -mx-6 border-t border-border bg-surface px-6 py-3">
                  <div className="space-y-2">
                    <Label htmlFor="rev-note">What changed</Label>
                    <Input
                      id="rev-note"
                      name="changeNote"
                      placeholder="Raised the approval threshold to $500"
                    />
                    <div className="flex items-center gap-2">
                      <Button type="submit" disabled={busy}>
                        {busy ? 'Publishing…' : `Publish v${selected.version + 1}`}
                      </Button>
                      <Button type="button" variant="outline" onClick={() => setMode({ kind: 'read' })}>
                        Cancel
                      </Button>
                      <span className="text-xs text-fg-muted">
                        v{selected.version} stays in history; runs that followed it keep pointing at it.
                      </span>
                    </div>
                  </div>
                </div>
              </form>
            ) : null}

            {tab === 'applies' ? (
              <form action={(form) => act(setProcedureAssignment, form)} className="space-y-3">
                <input type="hidden" name="procedureId" value={selected.id} />
                <div className="space-y-2">
                  <Label>Who follows this</Label>
                  <AssignmentFields
                    rolePackOptions={rolePackOptions}
                    handOptions={handOptions}
                    current={selected.assignment}
                  />
                </div>
                <Button type="submit" variant="outline" size="sm" disabled={busy}>
                  Save assignment
                </Button>
              </form>
            ) : null}

            {tab === 'history' ? (
              <div className="space-y-2">
                <p className="text-xs text-fg-muted">
                  Every version ever published. Changes append — a revision is never edited in place.
                </p>
                {selected.revisions.map((rev) => (
                  <button
                    key={rev.version}
                    type="button"
                    onClick={() => {
                      setViewingVersion(rev.version === selected.version ? null : rev.version)
                      setTab('procedure')
                    }}
                    className="flex w-full items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-left text-sm transition-colors hover:border-primary/50"
                  >
                    <span className="flex items-center gap-2">
                      <Badge variant={rev.version === selected.version ? 'default' : 'outline'}>v{rev.version}</Badge>
                      {rev.changeNote ? <span className="text-fg-muted">{rev.changeNote}</span> : null}
                    </span>
                    <span className="text-xs text-fg-muted">{rev.createdAt}</span>
                  </button>
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
