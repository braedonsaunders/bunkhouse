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
} from '@braedonsaunders/appkit-ui'
import type { Role } from '../lib/roles'
import type { ResourceCatalog, ResourceEntry, RoleResourceKind } from '../lib/role-resources'
import { hireAgent } from '../app/organization/actions'
import { deleteRoleDef, installRoleStarterProcedures, saveRoleDef, setRoleResources } from '../app/roles/actions'
import { cronToHuman } from '../lib/schedule'
import {
  ACTION_CATEGORIES,
  AUTONOMY_LEVELS,
  CATEGORY_LABELS,
  DEFAULT_AUTONOMY_LEVEL,
} from '../lib/autonomy'
import { MarkdownEditor } from './markdown-editor'
import { ScheduleBuilder } from './schedule-builder'
import { SectionTabs } from './section-tabs'

export type RosterOption = { id: string; name: string; title: string }

/** The resource kinds a role links, in the order they appear on the record. */
const RESOURCE_TABS: {
  kind: RoleResourceKind
  label: string
  /** What linking one of these actually does for an agent holding the role. */
  blurb: string
  empty: string
}[] = [
  {
    kind: 'procedures',
    label: 'Procedures',
    blurb:
      'Company doctrine every agent in this role follows and cites. Write it once under Company resources — this is where you give it to a role.',
    empty: 'No procedures written yet. Author them under Company resources, then give them to this role here.',
  },
  {
    kind: 'skills',
    label: 'Skills',
    blurb: 'Competence this role can draw on. Indexed in the agent’s prompt and loaded when it is relevant.',
    empty: 'No skills installed yet. Install them under Company resources, then give them to this role here.',
  },
  {
    kind: 'notes',
    label: 'Knowledge',
    blurb: 'Company knowledge this role is given. Everything else in the company’s notes stays out of its prompt.',
    empty: 'No company knowledge written yet.',
  },
  {
    kind: 'systems',
    label: 'Systems',
    blurb: 'The outside software this role works in. Its tools appear in the toolbox of every agent holding the role.',
    empty: 'No systems connected yet. Connect them under Company resources, then give them to this role here.',
  },
]

/** Resources reaching a role: the ones linked to it, plus company-wide ones. */
const reaching = (entries: ResourceEntry[], roleSlug: string) =>
  entries.filter((entry) => entry.assignment.everyone || (entry.assignment.roles?.includes(roleSlug) ?? false))

const linkedKeys = (entries: ResourceEntry[], roleSlug: string) =>
  entries.filter((entry) => entry.assignment.roles?.includes(roleSlug) ?? false).map((entry) => entry.key)

type EditorState = {
  roleId?: string
  title: string
  pitch: string
  description: string
  bio: string
  tone: string
  inboundPolicy: string
  suggestedSalaryUsd: number
  duties: { title: string; instruction: string; cron: string }[]
  autonomy: Record<string, string>
}

const blankEditor = (): EditorState => ({
  title: '',
  pitch: '',
  description: '',
  bio: '',
  tone: '',
  inboundPolicy: 'staff_only',
  suggestedSalaryUsd: 50,
  duties: [],
  autonomy: {},
})

const editorFromRole = (role: Role, keepId: boolean): EditorState => ({
  ...(keepId && role.id ? { roleId: role.id } : {}),
  title: keepId ? role.title : `${role.title} (custom)`,
  pitch: role.pitch,
  description: role.description,
  bio: role.personality.bio,
  tone: role.personality.tone.join(', '),
  inboundPolicy: role.inboundPolicy,
  suggestedSalaryUsd: role.suggestedSalaryUsd,
  duties: role.duties.map((d) => ({ title: d.title, instruction: d.instruction, cron: d.cron })),
  autonomy: Object.fromEntries(Object.entries(role.autonomyDefaults)),
})

/**
 * The role catalog: browse, build your own, give a role the company resources
 * it works from, and onboard agents into it.
 *
 * A role links resources rather than restating them. The toggles on the record
 * write the resource's own "applies to" — the same field the Company resources
 * screens write — so doctrine is authored once and given out from either end.
 */
export function RolesView({
  roles,
  roster,
  catalog,
}: {
  roles: Role[]
  roster: RosterOption[]
  catalog: ResourceCatalog
}) {
  const [selectedSlug, setSelectedSlug] = React.useState<string | null>(null)
  const [recordTab, setRecordTab] = React.useState('overview')
  const [onboarding, setOnboarding] = React.useState<Role | null>(null)
  const [editor, setEditor] = React.useState<EditorState | null>(null)
  const [editorTab, setEditorTab] = React.useState('basics')
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()
  /** The picker's working set, per kind, for the role currently open. */
  const [draft, setDraft] = React.useState<Record<string, string[]>>({})

  const selected = roles.find((role) => role.slug === selectedSlug) ?? null

  const columns: RecordColumn<Role>[] = [
    { key: 'title', label: 'Role', sortable: true },
    {
      key: 'origin',
      label: 'Origin',
      kind: 'status',
      sortable: true,
      statusVariant: (value) => (value === 'custom' ? 'default' : 'secondary'),
    },
    { key: 'pitch', label: 'What they do' },
    {
      key: 'duties',
      label: 'Duties',
      align: 'right',
      render: (row) => <span className="tabular-nums">{row.duties.length}</span>,
    },
    {
      key: 'resources',
      label: 'Resources',
      align: 'right',
      render: (row) => (
        <span className="tabular-nums">
          {RESOURCE_TABS.reduce((total, tab) => total + reaching(catalog[tab.kind], row.slug).length, 0)}
        </span>
      ),
    },
    { key: 'suggestedSalaryUsd', label: 'Salary', kind: 'amount', sortable: true, format: (v) => `$${v as number}/mo` },
  ]

  const act = (action: (form: FormData) => Promise<void>, form: FormData, onDone?: () => void) =>
    startBusy(async () => {
      setError(null)
      try {
        await action(form)
        onDone?.()
      } catch (err) {
        if (err && typeof err === 'object' && 'digest' in err) throw err
        setError(err instanceof Error ? err.message : String(err))
      }
    })

  const openRecord = (role: Role) => {
    setError(null)
    setRecordTab('overview')
    setDraft(Object.fromEntries(RESOURCE_TABS.map((tab) => [tab.kind, linkedKeys(catalog[tab.kind], role.slug)])))
    setSelectedSlug(role.slug)
  }

  // Already filtered to what is not in the library yet — the page resolves that
  // against real procedure slugs rather than guessing from titles here.
  const uninstalledSeeds = selected?.seedProcedures ?? []

  return (
    <>
      <RecordList
        columns={columns}
        rows={roles}
        getRowId={(row) => row.slug}
        onRowClick={openRecord}
        toolbarActions={
          <Button size="sm" onClick={() => { setEditorTab('basics'); setEditor(blankEditor()) }}>
            New role
          </Button>
        }
        empty={{ title: 'No roles', description: 'Build a role — it defines the job an agent is onboarded into.' }}
      />

      {/* Role record */}
      <Drawer
        open={selected !== null && editor === null && onboarding === null}
        onClose={() => setSelectedSlug(null)}
        title={selected?.title ?? ''}
        description={selected?.pitch}
        size="2xl"
        headerActions={
          selected ? (
            <span className="flex items-center gap-2">
              <Button size="sm" onClick={() => setOnboarding(selected)}>
                Onboard an agent
              </Button>
              {selected.origin === 'custom' ? (
                <Button size="sm" variant="outline" onClick={() => { setEditorTab('basics'); setEditor(editorFromRole(selected, true)) }}>
                  Edit role
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => { setEditorTab('basics'); setEditor(editorFromRole(selected, false)) }}>
                  Duplicate to customize
                </Button>
              )}
            </span>
          ) : null
        }
      >
        {selected ? (
          <div className="space-y-4">
            <SectionTabs
              tabs={[
                { key: 'overview', label: 'Overview' },
                { key: 'duties', label: 'Duties', count: selected.duties.length },
                ...RESOURCE_TABS.map((tab) => ({
                  key: tab.kind,
                  label: tab.label,
                  count: reaching(catalog[tab.kind], selected.slug).length,
                })),
              ]}
              active={recordTab}
              onSelect={(key) => {
                setRecordTab(key)
                setError(null)
              }}
              ariaLabel="Role sections"
            />

            {recordTab === 'overview' ? (
              <div className="space-y-4 text-sm">
                <p className="text-fg-muted">{selected.description}</p>
                <p className="text-fg-muted">{selected.personality.bio}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">inbound: {selected.inboundPolicy.replace('_', ' ')}</Badge>
                  <Badge variant="outline">${selected.suggestedSalaryUsd}/mo suggested</Badge>
                  {selected.personality.tone.map((tone) => (
                    <Badge key={tone} variant="secondary">
                      {tone}
                    </Badge>
                  ))}
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Day-one autonomy</p>
                  <div className="flex flex-wrap gap-2">
                    {ACTION_CATEGORIES.map((category) => (
                      <Badge key={category} variant="outline">
                        {CATEGORY_LABELS[category]}: {selected.autonomyDefaults[category] ?? DEFAULT_AUTONOMY_LEVEL}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            {recordTab === 'duties' ? (
              <div className="space-y-2 text-sm">
                <p className="text-fg-muted">
                  Standing work this role does on a schedule. Each agent onboarded into the role gets its own copy, on
                  its own clock — duties belong to the job, not to a shared library.
                </p>
                {selected.duties.length === 0 ? (
                  <p className="text-fg-muted">None — this role works reactively.</p>
                ) : (
                  <ul className="space-y-1">
                    {selected.duties.map((duty) => (
                      <li key={duty.slug} className="rounded-md border border-border px-3 py-2">
                        <span className="flex items-center justify-between gap-2">
                          <span className="font-medium">{duty.title}</span>
                          <Badge variant="outline">{cronToHuman(duty.cron)}</Badge>
                        </span>
                        <span className="mt-0.5 block text-xs text-fg-muted">{duty.instruction}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}

            {RESOURCE_TABS.filter((tab) => tab.kind === recordTab).map((tab) => {
              const entries = catalog[tab.kind]
              const picked = draft[tab.kind] ?? []
              const saved = linkedKeys(entries, selected.slug)
              const dirty =
                picked.length !== saved.length || picked.some((key) => !saved.includes(key))
              return (
                <div key={tab.kind} className="space-y-3">
                  <p className="text-sm text-fg-muted">{tab.blurb}</p>

                  {tab.kind === 'procedures' && uninstalledSeeds.length > 0 ? (
                    <div className="space-y-2 rounded-md border border-dashed border-border p-3">
                      <p className="text-sm">
                        This role ships {uninstalledSeeds.length}{' '}
                        {uninstalledSeeds.length === 1 ? 'procedure' : 'procedures'} you can add to the company&apos;s
                        library: {uninstalledSeeds.map((seed) => seed.title).join(', ')}.
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          const form = new FormData()
                          form.set('roleSlug', selected.slug)
                          act(installRoleStarterProcedures, form)
                        }}
                      >
                        {busy ? 'Adding…' : 'Add them to the library'}
                      </Button>
                      <p className="text-xs text-fg-muted">
                        They arrive as version 1, assigned to this role, and are yours to revise from there.
                      </p>
                    </div>
                  ) : null}

                  {entries.length === 0 ? (
                    <p className="text-sm text-fg-muted">{tab.empty}</p>
                  ) : (
                    <ul className="divide-y divide-border rounded-lg border border-border">
                      {entries.map((entry) => {
                        const everyone = entry.assignment.everyone ?? false
                        const on = everyone || picked.includes(entry.key)
                        return (
                          <li key={entry.key} className="flex items-center justify-between gap-3 px-3 py-2">
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium">{entry.title}</span>
                              <span className="block truncate text-xs text-fg-muted">{entry.detail}</span>
                            </span>
                            {everyone ? (
                              <Badge variant="secondary">Everyone</Badge>
                            ) : (
                              <button
                                type="button"
                                aria-pressed={on}
                                onClick={() =>
                                  setDraft({
                                    ...draft,
                                    [tab.kind]: on
                                      ? picked.filter((key) => key !== entry.key)
                                      : [...picked, entry.key],
                                  })
                                }
                                className={
                                  on
                                    ? 'shrink-0 rounded-md border border-primary bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary'
                                    : 'shrink-0 rounded-md border border-border px-2.5 py-1 text-xs text-fg-muted hover:border-primary/50'
                                }
                              >
                                {on ? 'Given' : 'Give'}
                              </button>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      disabled={busy || !dirty}
                      onClick={() => {
                        const form = new FormData()
                        form.set('roleSlug', selected.slug)
                        form.set('kind', tab.kind)
                        form.set('keys', picked.join(','))
                        act(setRoleResources, form)
                      }}
                    >
                      {busy ? 'Saving…' : 'Save'}
                    </Button>
                    {dirty ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setDraft({ ...draft, [tab.kind]: saved })}
                      >
                        Discard
                      </Button>
                    ) : null}
                    <span className="text-xs text-fg-muted">
                      A resource marked Everyone already reaches this role; narrow it on the resource itself.
                    </span>
                  </div>
                </div>
              )
            })}

            {error ? <p className="text-sm text-danger">{error}</p> : null}
          </div>
        ) : null}
      </Drawer>

      {/* Onboarding */}
      <Drawer
        open={onboarding !== null}
        onClose={() => setOnboarding(null)}
        title={onboarding ? `Onboard — ${onboarding.title}` : ''}
        description="They start onboarding immediately; connect their mailbox to bring them online."
        size="md"
      >
        {onboarding ? (
          <form
            action={(form) => {
              form.set('rolePack', onboarding.slug)
              // The zone the hiring operator is sitting in, so the role's
              // standing duties keep the hours their titles claim rather than
              // resolving against whatever clock the worker happens to run on.
              form.set('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone)
              act(hireAgent, form)
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="ob-name">Name</Label>
              <Input id="ob-name" name="name" placeholder="Dana Reeves" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ob-email">Email address on your domain</Label>
              <Input id="ob-email" name="email" type="email" placeholder="dana@yourcompany.com" required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="ob-salary">Monthly salary (USD)</Label>
                <Input id="ob-salary" name="salaryUsd" type="number" min={1} step={1} defaultValue={onboarding.suggestedSalaryUsd} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ob-reports">Reports to</Label>
                <Select id="ob-reports" name="reportsToId" defaultValue="">
                  <option value="">— Nobody yet —</option>
                  {roster.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name} — {person.title}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ob-bio">Personality (the role has a good default)</Label>
              <Textarea id="ob-bio" name="bio" rows={3} defaultValue={onboarding.personality.bio} />
            </div>
            <p className="text-xs text-fg-muted">
              They pick up everything this role is given — procedures, skills, knowledge and systems — by holding it.
            </p>
            <Button type="submit" disabled={busy}>
              {busy ? 'Onboarding…' : 'Start onboarding'}
            </Button>
            {error ? <p className="text-sm text-danger">{error}</p> : null}
          </form>
        ) : null}
      </Drawer>

      {/* Role builder */}
      <Drawer
        open={editor !== null}
        onClose={() => setEditor(null)}
        title={editor?.roleId ? 'Edit role' : 'New role'}
        description="The job itself: personality, standing duties, trust posture. Resources are given to the role on its record."
        size="2xl"
      >
        {editor ? (
          <div className="space-y-5">
            <SectionTabs
              tabs={[
                { key: 'basics', label: 'Basics' },
                { key: 'duties', label: 'Duties', count: editor.duties.length },
                { key: 'autonomy', label: 'Autonomy' },
              ]}
              active={editorTab}
              onSelect={setEditorTab}
              ariaLabel="Role builder sections"
            />

            {editorTab === 'basics' ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="rb-title">Title</Label>
                  <Input id="rb-title" value={editor.title} onChange={(e) => setEditor({ ...editor, title: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rb-pitch">Pitch (one line)</Label>
                  <Input id="rb-pitch" value={editor.pitch} onChange={(e) => setEditor({ ...editor, pitch: e.target.value })} />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="rb-desc">Description</Label>
                  <Textarea id="rb-desc" rows={2} value={editor.description} onChange={(e) => setEditor({ ...editor, description: e.target.value })} />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="rb-bio">Personality bio</Label>
                  <Textarea id="rb-bio" rows={2} value={editor.bio} onChange={(e) => setEditor({ ...editor, bio: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rb-tone">Tone (comma-separated)</Label>
                  <Input id="rb-tone" value={editor.tone} onChange={(e) => setEditor({ ...editor, tone: e.target.value })} placeholder="warm, organized, plain-spoken" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="rb-inbound">Who may email work</Label>
                    <Select id="rb-inbound" value={editor.inboundPolicy} onChange={(e) => setEditor({ ...editor, inboundPolicy: e.target.value })}>
                      <option value="staff_only">Staff only</option>
                      <option value="known_contacts">Staff + known contacts</option>
                      <option value="anyone">Anyone</option>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rb-salary">Suggested salary</Label>
                    <Input
                      id="rb-salary"
                      type="number"
                      min={1}
                      step={1}
                      value={editor.suggestedSalaryUsd}
                      onChange={(e) => setEditor({ ...editor, suggestedSalaryUsd: Number(e.target.value) || 1 })}
                    />
                  </div>
                </div>
              </div>
            ) : null}

            {editorTab === 'duties' ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Standing duties</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setEditor({ ...editor, duties: [...editor.duties, { title: '', instruction: '', cron: '0 8 * * 1-5' }] })
                    }
                  >
                    Add duty
                  </Button>
                </div>
                {editor.duties.map((duty, index) => (
                  <div key={index} className="space-y-3 rounded-md border border-border p-3">
                    <div className="flex items-center gap-2">
                      <Input
                        value={duty.title}
                        onChange={(e) => {
                          const duties = [...editor.duties]
                          duties[index] = { ...duty, title: e.target.value }
                          setEditor({ ...editor, duties })
                        }}
                        placeholder="Duty title"
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setEditor({ ...editor, duties: editor.duties.filter((_, i) => i !== index) })}
                      >
                        Remove
                      </Button>
                    </div>
                    <MarkdownEditor
                      defaultValue={duty.instruction}
                      placeholder="What to do, in the agent's own terms."
                      onChange={(md) => {
                        const duties = [...editor.duties]
                        duties[index] = { ...editor.duties[index]!, instruction: md }
                        setEditor({ ...editor, duties })
                      }}
                    />
                    <ScheduleBuilder
                      value={{ kind: 'cron', schedule: duty.cron }}
                      idPrefix={`rb-duty-${index}`}
                      allowOnce={false}
                      onChange={({ schedule }) => {
                        const duties = [...editor.duties]
                        duties[index] = { ...editor.duties[index]!, cron: schedule }
                        setEditor({ ...editor, duties })
                      }}
                    />
                  </div>
                ))}
              </div>
            ) : null}

            {editorTab === 'autonomy' ? (
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Day-one autonomy defaults</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {ACTION_CATEGORIES.map((category) => (
                    <div key={category} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                      <span className="text-xs">{CATEGORY_LABELS[category]}</span>
                      <Select
                        value={editor.autonomy[category] ?? DEFAULT_AUTONOMY_LEVEL}
                        onChange={(e) => setEditor({ ...editor, autonomy: { ...editor.autonomy, [category]: e.target.value } })}
                        aria-label={CATEGORY_LABELS[category]}
                      >
                        {AUTONOMY_LEVELS.map((level) => (
                          <option key={level} value={level}>
                            {level}
                          </option>
                        ))}
                      </Select>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex items-center gap-3 border-t border-border pt-4">
              <Button
                type="button"
                disabled={busy}
                onClick={() => {
                  const form = new FormData()
                  if (editor.roleId) form.set('roleId', editor.roleId)
                  form.set('title', editor.title)
                  form.set('pitch', editor.pitch)
                  form.set('description', editor.description)
                  form.set('bio', editor.bio)
                  form.set('tone', editor.tone)
                  form.set('inboundPolicy', editor.inboundPolicy)
                  form.set('suggestedSalaryUsd', String(editor.suggestedSalaryUsd))
                  form.set('duties', JSON.stringify(editor.duties.map((d) => ({ ...d, slug: '' }))))
                  form.set('autonomyDefaults', JSON.stringify(editor.autonomy))
                  act(saveRoleDef, form, () => {
                    setEditor(null)
                    setSelectedSlug(null)
                  })
                }}
              >
                {busy ? 'Saving…' : editor.roleId ? 'Save role' : 'Create role'}
              </Button>
              {editor.roleId ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    const form = new FormData()
                    form.set('roleId', editor.roleId!)
                    act(deleteRoleDef, form, () => {
                      setEditor(null)
                      setSelectedSlug(null)
                    })
                  }}
                >
                  Delete role
                </Button>
              ) : null}
              {error ? <p className="text-sm text-danger">{error}</p> : null}
            </div>
          </div>
        ) : null}
      </Drawer>
    </>
  )
}
