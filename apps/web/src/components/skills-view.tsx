'use client'

import * as React from 'react'
import Link from 'next/link'
import { marked } from 'marked'
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
import type { ResourceAssignment } from '../db/schema'
import { SKILL_LIBRARY, SKILL_LIBRARY_GROUPS, type SkillLibraryEntry } from '../lib/skill-library'
import { AssignmentFields, type AssignOption } from './procedures-view'
import {
  installLibrarySkillAction,
  installSkillFromRepoAction,
  removeSkillAction,
  setSkillAssignmentAction,
  setSkillStatusAction,
  updateSkillAction,
} from '../app/resources/skill-actions'

/**
 * Skills: portable competence an agent can draw on, installed from a
 * repository rather than written here. The list is the record; installing and
 * governing happen in drawers, so no form ever sits under the table.
 *
 * A skill is not a procedure and the screen says so plainly — a procedure
 * binds, a skill is available. What an operator governs here is who may reach
 * for it, and whether the code it ships is allowed to run.
 */

export type SkillFileView = {
  path: string
  sizeBytes: number
  isScript: boolean
}

export type SkillRowView = {
  id: string
  slug: string
  title: string
  description: string
  status: 'active' | 'disabled'
  version: number
  appliesTo: string
  /** `owner/repo` with the folder, as installed. */
  origin: string
  /** Short commit the version is pinned to. */
  pinned: string
  licence: string
  hasScripts: boolean
  updatedAt: string
  /** The markdown instructions of the current version. */
  body: string
  files: SkillFileView[]
  assignment: ResourceAssignment
}

const COLUMNS: RecordColumn<SkillRowView>[] = [
  {
    key: 'title',
    label: 'Skill',
    sortable: true,
    render: (row) => (
      <span className="min-w-0">
        <span className="block truncate font-medium text-primary">{row.title}</span>
        <span className="block truncate text-xs text-fg-muted">{row.description}</span>
      </span>
    ),
  },
  {
    key: 'status',
    label: 'Status',
    kind: 'status',
    sortable: true,
    statusVariant: (value) => (value === 'active' ? 'default' : 'outline'),
  },
  { key: 'appliesTo', label: 'Available to' },
  {
    key: 'hasScripts',
    label: 'Ships code',
    render: (row) => (row.hasScripts ? <Badge variant="outline">scripts</Badge> : <span className="text-fg-muted">—</span>),
  },
  { key: 'version', label: 'Version', align: 'right', sortable: true, format: (v) => `v${v as number}` },
  { key: 'updatedAt', label: 'Updated', sortable: true },
]

const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

type Panel = { kind: 'library' } | { kind: 'repo' } | { kind: 'record'; id: string }

export function SkillsView({
  rows,
  roleOptions,
  agentOptions,
  /** Whether this deployment can run sandboxed shell commands at all. */
  shellAvailable,
}: {
  rows: SkillRowView[]
  roleOptions: AssignOption[]
  agentOptions: AssignOption[]
  shellAvailable: boolean
}) {
  const [panel, setPanel] = React.useState<Panel | null>(null)
  const [query, setQuery] = React.useState('')

  const q = query.trim().toLowerCase()
  const shown = q ? rows.filter((row) => `${row.title} ${row.slug} ${row.description}`.toLowerCase().includes(q)) : rows
  const selected = panel?.kind === 'record' ? (rows.find((row) => row.id === panel.id) ?? null) : null

  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-muted">
        Reusable know-how your agents can draw on — how to build a clean spreadsheet, how to lay out a proposal.
        Installed from a repository and pinned to the exact version you installed, so an agent&apos;s work never changes
        underneath you. Unlike a procedure, a skill does not bind: an agent reaches for it when the job calls for it.
      </p>

      <RecordList
        columns={COLUMNS}
        rows={shown}
        getRowId={(row) => row.id}
        onRowClick={(row) => setPanel({ kind: 'record', id: row.id })}
        search={{ value: query, onChange: setQuery, placeholder: 'Search skills…' }}
        toolbarActions={
          <span className="flex items-center gap-2">
            <Button size="sm" onClick={() => setPanel({ kind: 'library' })}>
              Browse library
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPanel({ kind: 'repo' })}>
              Install from repository
            </Button>
          </span>
        }
        empty={{
          title: 'No skills installed',
          description:
            'Pick one from the library — or paste any repository that publishes skills — then choose which agents may use it.',
          action: <Button onClick={() => setPanel({ kind: 'library' })}>Browse library</Button>,
        }}
      />

      {panel?.kind === 'library' ? (
        <LibraryDrawer installedSlugs={new Set(rows.map((row) => row.slug))} onClose={() => setPanel(null)} />
      ) : null}
      {panel?.kind === 'repo' ? <RepoDrawer onClose={() => setPanel(null)} /> : null}
      {selected ? (
        <SkillDrawer
          key={selected.id}
          skill={selected}
          roleOptions={roleOptions}
          agentOptions={agentOptions}
          shellAvailable={shellAvailable}
          onClose={() => setPanel(null)}
        />
      ) : null}
    </div>
  )
}

/** The curated shelf. Licence is on the card, not buried in the record — it is
 *  a decision the company should make before installing, not discover after. */
function LibraryDrawer({ installedSlugs, onClose }: { installedSlugs: Set<string>; onClose: () => void }) {
  const [query, setQuery] = React.useState('')
  const [busySlug, setBusySlug] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const q = query.trim().toLowerCase()
  const matches = (entry: SkillLibraryEntry) =>
    !q || `${entry.label} ${entry.description} ${entry.group}`.toLowerCase().includes(q)

  const install = async (entry: SkillLibraryEntry) => {
    setError(null)
    setNotice(null)
    setBusySlug(entry.slug)
    try {
      const result = await installLibrarySkillAction(entry.slug)
      if (!result.ok) setError(result.message)
      else {
        const names = [...result.installed, ...result.updated]
        setNotice(`${names.join(', ')} installed. Choose who may use it on its record.`)
      }
    } finally {
      setBusySlug(null)
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title="Skill library"
      description="Skills worth a small company's time, ready to install. Anything not listed here still works — use Install from repository and paste its address."
      size="md"
    >
      <div className="space-y-5">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search the library…"
          aria-label="Search the library"
        />
        {notice ? <p className="text-sm text-fg-muted">{notice}</p> : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}

        {SKILL_LIBRARY_GROUPS.map((group) => {
          const entries = SKILL_LIBRARY.filter((entry) => entry.group === group && matches(entry))
          if (entries.length === 0) return null
          return (
            <div key={group}>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">{group}</p>
              <div className="space-y-2">
                {entries.map((entry) => (
                  <div key={entry.slug} className="rounded-md border border-border px-3 py-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-primary">{entry.label}</span>
                          {entry.hasScripts ? <Badge variant="outline">scripts</Badge> : null}
                          {installedSlugs.has(entry.slug) ? <Badge variant="secondary">installed</Badge> : null}
                        </span>
                        <span className="mt-0.5 block text-sm text-fg-muted">{entry.description}</span>
                        <span className="mt-1 block text-xs text-fg-subtle">
                          {entry.repo}/{entry.path} · {entry.licence}
                        </span>
                      </span>
                      <Button
                        size="sm"
                        variant={installedSlugs.has(entry.slug) ? 'outline' : 'default'}
                        disabled={busySlug !== null}
                        onClick={() => install(entry)}
                      >
                        {busySlug === entry.slug
                          ? 'Installing…'
                          : installedSlugs.has(entry.slug)
                            ? 'Reinstall'
                            : 'Install'}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
        {SKILL_LIBRARY.some(matches) ? null : (
          <p className="text-sm text-fg-muted">
            Nothing in the library matches. Any repository that publishes skills still works — close this and use
            Install from repository.
          </p>
        )}
      </div>
    </Drawer>
  )
}

/** Install from anywhere. Pasting the address of a whole collection installs
 *  every skill in it, which is what an operator means by pasting it. */
function RepoDrawer({ onClose }: { onClose: () => void }) {
  const [address, setAddress] = React.useState('')
  const [branch, setBranch] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  return (
    <Drawer
      open
      onClose={onClose}
      title="Install from a repository"
      description="Any public GitHub repository that publishes skills in the standard SKILL.md format. The skill is copied into your company and pinned to the version you install."
      size="md"
    >
      <div className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="skill-repo">Repository or folder address</Label>
          <Input
            id="skill-repo"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="anthropics/skills — or paste the folder's GitHub address"
          />
          <p className="text-xs text-fg-muted">
            Point at one skill&apos;s folder to install it alone, or at a whole repository to install everything it
            publishes.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="skill-branch">Branch or tag (optional)</Label>
          <Input
            id="skill-branch"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            placeholder="Defaults to the repository's main branch"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={busy || !address.trim()}
            onClick={async () => {
              setError(null)
              setNotice(null)
              setBusy(true)
              try {
                const result = await installSkillFromRepoAction({
                  address,
                  ...(branch.trim() ? { ref: branch.trim() } : {}),
                })
                if (!result.ok) {
                  setError(result.message)
                  return
                }
                const installed = result.installed.length
                const updated = result.updated.length
                setNotice(
                  `${installed > 0 ? `${installed} installed` : ''}${installed > 0 && updated > 0 ? ', ' : ''}${
                    updated > 0 ? `${updated} updated` : ''
                  }. Choose who may use them on each record.`,
                )
                setAddress('')
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'Reading…' : 'Install'}
          </Button>
          {notice ? <p className="text-sm text-fg-muted">{notice}</p> : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      </div>
    </Drawer>
  )
}

/** The record: what it says, what it ships, who may use it, where it came from. */
function SkillDrawer({
  skill,
  roleOptions,
  agentOptions,
  shellAvailable,
  onClose,
}: {
  skill: SkillRowView
  roleOptions: AssignOption[]
  agentOptions: AssignOption[]
  shellAvailable: boolean
  onClose: () => void
}) {
  const [tab, setTab] = React.useState('instructions')
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const instructionsHtml = React.useMemo(() => marked.parse(skill.body, { async: false }), [skill.body])

  const act = async (work: () => Promise<void>) => {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      await work()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={skill.title}
      description={skill.description}
      size="2xl"
    >
      <div className="space-y-4">
        <SubtabNav
          ariaLabel="Skill sections"
          active={tab}
          onSelect={setTab}
          tabs={[
            { key: 'instructions', label: 'Instructions' },
            { key: 'files', label: 'Files', count: skill.files.length },
            { key: 'availability', label: 'Available to' },
            { key: 'source', label: 'Source' },
          ]}
        />

        {tab === 'instructions' ? (
          <div
            className="prose prose-sm max-w-none rounded-lg border border-border bg-surface p-4 dark:prose-invert"
            dangerouslySetInnerHTML={{ __html: instructionsHtml }}
          />
        ) : null}

        {tab === 'files' ? (
          <div className="space-y-3">
            {skill.hasScripts ? <ScriptNotice shellAvailable={shellAvailable} /> : null}
            {skill.files.length === 0 ? (
              <p className="text-sm text-fg-muted">
                This skill is instructions only — it ships no extra files.
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {skill.files.map((file) => (
                  <li key={file.path} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-xs">{file.path}</span>
                      {file.isScript ? <Badge variant="outline">script</Badge> : null}
                    </span>
                    <span className="shrink-0 text-xs text-fg-muted">{formatBytes(file.sizeBytes)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {tab === 'availability' ? (
          <form action={(form) => act(async () => await setSkillAssignmentAction(form))} className="space-y-4">
            <input type="hidden" name="skillId" value={skill.id} />
            <div className="space-y-2">
              <Label>Which agents may use this</Label>
              <p className="text-xs text-fg-muted">
                An agent sees the name and description of every skill available to it, and reads the full instructions
                only when it decides one applies.
              </p>
              <AssignmentFields
                roleOptions={roleOptions}
                agentOptions={agentOptions}
                current={skill.assignment}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    const result = await setSkillStatusAction({
                      skillId: skill.id,
                      status: skill.status === 'active' ? 'disabled' : 'active',
                    })
                    if (!result.ok) setError(result.message)
                  })
                }
              >
                {skill.status === 'active' ? 'Turn off' : 'Turn back on'}
              </Button>
            </div>
            {notice ? <p className="text-sm text-fg-muted">{notice}</p> : null}
            {error ? <p className="text-sm text-danger">{error}</p> : null}
          </form>
        ) : null}

        {tab === 'source' ? (
          <div className="space-y-4">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="text-fg-muted">Installed from</dt>
              <dd className="font-mono text-xs">{skill.origin}</dd>
              <dt className="text-fg-muted">Pinned to</dt>
              <dd className="font-mono text-xs">{skill.pinned}</dd>
              <dt className="text-fg-muted">Version here</dt>
              <dd>v{skill.version}</dd>
              <dt className="text-fg-muted">Licence</dt>
              <dd>{skill.licence}</dd>
            </dl>
            <p className="text-xs text-fg-muted">
              Nothing is fetched while an agent works — this copy is what they read. Checking for a new version reads
              the repository now and, if it has moved on, installs the newer one as v{skill.version + 1}. The version
              here stays on the record either way.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    const result = await updateSkillAction(skill.id)
                    if (!result.ok) setError(result.message)
                    else if (result.changed) setNotice(`Updated to v${result.version}.`)
                    else setNotice('Already the latest published version.')
                  })
                }
              >
                {busy ? 'Checking…' : 'Check for a new version'}
              </Button>
              <form action={(form) => act(async () => { await removeSkillAction(form); onClose() })}>
                <input type="hidden" name="skillId" value={skill.id} />
                <Button type="submit" variant="destructive" disabled={busy}>
                  Remove
                </Button>
              </form>
            </div>
            {notice ? <p className="text-sm text-fg-muted">{notice}</p> : null}
            {error ? <p className="text-sm text-danger">{error}</p> : null}
          </div>
        ) : null}
      </div>
    </Drawer>
  )
}

/**
 * What shipping code actually means here, in the operator's terms. A skill's
 * scripts are not a second kind of permission: they run through the same
 * sandboxed shell an agent already has, under the same dial, on the same
 * record. If the shell is off, they simply never run.
 */
function ScriptNotice({ shellAvailable }: { shellAvailable: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3 text-sm">
      <p className="font-medium">This skill ships code.</p>
      <p className="mt-1 text-fg-muted">
        {shellAvailable ? (
          <>
            Its scripts run in the agent&apos;s sandboxed workspace, through the same shell it already has — governed by
            each agent&apos;s Shell setting on the{' '}
            <Link href="/admin/settings?section=autonomy" className="text-primary underline underline-offset-2">
              autonomy dial
            </Link>
            , and recorded like any other command. An agent whose Shell is set to ask will wait for a person before
            anything runs.
          </>
        ) : (
          <>
            This deployment does not run shell commands, so the scripts stay inert — the instructions still work on
            their own. Nothing here can run until sandboxed shell work is available on the server.
          </>
        )}
      </p>
    </div>
  )
}
