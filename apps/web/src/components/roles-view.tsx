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
  Textarea,
  type RecordColumn,
} from '@appkit/ui'
import type { Role } from '../lib/roles'
import { hireHand } from '../app/people/actions'
import { deleteRoleDef, saveRoleDef } from '../app/roles/actions'
import { cronToHuman } from '../lib/schedule'
import { MarkdownEditor } from './markdown-editor'
import { ScheduleBuilder } from './schedule-builder'

export type RosterOption = { id: string; name: string; title: string }

const CATEGORY_LABELS: Record<string, string> = {
  external_email: 'External email',
  internal_email: 'Internal email',
  record_write: 'Record changes',
  money_adjacent: 'Money-adjacent',
  file_write: 'File writes',
  computer_use: 'Computer use',
  shell: 'Terminal / shell',
  phone_call: 'Phone calls',
}

const COLUMNS: RecordColumn<Role>[] = [
  { key: 'title', label: 'Role', sortable: true },
  {
    key: 'origin',
    label: 'Origin',
    kind: 'status',
    sortable: true,
    statusVariant: (value) => (value === 'custom' ? 'default' : 'secondary'),
  },
  { key: 'pitch', label: 'What they do' },
  { key: 'duties', label: 'Duties', align: 'right', render: (row) => <span className="tabular-nums">{row.duties.length}</span> },
  {
    key: 'procedures',
    label: 'Procedures',
    align: 'right',
    render: (row) => <span className="tabular-nums">{row.procedures.length}</span>,
  },
  { key: 'suggestedSalaryUsd', label: 'Salary', kind: 'amount', sortable: true, format: (v) => `$${v as number}/mo` },
]

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
  procedures: { title: string; body: string }[]
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
  procedures: [],
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
  procedures: role.procedures.map((p) => ({ title: p.title, body: p.body })),
  autonomy: Object.fromEntries(Object.entries(role.autonomyDefaults)),
})

/** The role catalog: browse, build your own, onboard hands from any role. */
export function RolesView({ roles, roster }: { roles: Role[]; roster: RosterOption[] }) {
  const [selected, setSelected] = React.useState<Role | null>(null)
  const [onboarding, setOnboarding] = React.useState<Role | null>(null)
  const [editor, setEditor] = React.useState<EditorState | null>(null)
  const [editorTab, setEditorTab] = React.useState('basics')
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

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

  return (
    <>
      <RecordList
        columns={COLUMNS}
        rows={roles}
        getRowId={(row) => row.slug}
        onRowClick={(row) => {
          setError(null)
          setSelected(row)
        }}
        toolbarActions={
          <Button size="sm" onClick={() => { setEditorTab('basics'); setEditor(blankEditor()) }}>
            New role
          </Button>
        }
        empty={{ title: 'No roles', description: 'Build a role — it defines the job a hand is onboarded into.' }}
      />

      {/* Role detail */}
      <Drawer
        open={selected !== null && editor === null && onboarding === null}
        onClose={() => setSelected(null)}
        title={selected?.title ?? ''}
        description={selected?.pitch}
        size="lg"
        headerActions={
          selected ? (
            <span className="flex items-center gap-2">
              <Button size="sm" onClick={() => setOnboarding(selected)}>
                Onboard a hand
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
          <div className="space-y-5 text-sm">
            <p className="text-fg-muted">{selected.description}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Standing duties</p>
                {selected.duties.length === 0 ? (
                  <p className="text-fg-muted">None — reactive role.</p>
                ) : (
                  <ul className="space-y-1">
                    {selected.duties.map((duty) => (
                      <li key={duty.slug} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                        <span>{duty.title}</span>
                        <Badge variant="outline">{cronToHuman(duty.cron)}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Binding procedures</p>
                {selected.procedures.length === 0 ? (
                  <p className="text-fg-muted">None.</p>
                ) : (
                  <ul className="space-y-1">
                    {selected.procedures.map((procedure) => (
                      <li key={procedure.slug} className="rounded-md border border-border px-3 py-2">
                        {procedure.title}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">inbound: {selected.inboundPolicy.replace('_', ' ')}</Badge>
              <Badge variant="outline">${selected.suggestedSalaryUsd}/mo suggested</Badge>
              {Object.entries(selected.autonomyDefaults).map(([category, level]) => (
                <Badge key={category} variant="secondary">
                  {CATEGORY_LABELS[category] ?? category}: {level}
                </Badge>
              ))}
            </div>
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
              act(hireHand, form)
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
        description="The full job definition: personality, duties, procedures, trust posture."
        size="2xl"
      >
        {editor ? (
          <div className="space-y-5">
            <SubtabNav
              tabs={[
                { key: 'basics', label: 'Basics' },
                { key: 'duties', label: 'Duties', count: editor.duties.length },
                { key: 'procedures', label: 'Procedures', count: editor.procedures.length },
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
                      placeholder="What to do, in the hand's own terms."
                      onChange={(md) => {
                        const duties = [...editor.duties]
                        duties[index] = { ...editor.duties[index]!, instruction: md }
                        setEditor({ ...editor, duties })
                      }}
                    />
                    <ScheduleBuilder
                      value={duty.cron}
                      idPrefix={`rb-duty-${index}`}
                      onChange={(cron) => {
                        const duties = [...editor.duties]
                        duties[index] = { ...editor.duties[index]!, cron }
                        setEditor({ ...editor, duties })
                      }}
                    />
                  </div>
                ))}
              </div>
            ) : null}

            {editorTab === 'procedures' ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Binding procedures</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setEditor({ ...editor, procedures: [...editor.procedures, { title: '', body: '' }] })}
                  >
                    Add procedure
                  </Button>
                </div>
                {editor.procedures.map((procedure, index) => (
                  <div key={index} className="space-y-3 rounded-md border border-border p-3">
                    <div className="flex items-center gap-2">
                      <Input
                        value={procedure.title}
                        onChange={(e) => {
                          const procedures = [...editor.procedures]
                          procedures[index] = { ...procedure, title: e.target.value }
                          setEditor({ ...editor, procedures })
                        }}
                        placeholder="Procedure title"
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setEditor({ ...editor, procedures: editor.procedures.filter((_, i) => i !== index) })}
                      >
                        Remove
                      </Button>
                    </div>
                    <MarkdownEditor
                      defaultValue={procedure.body}
                      placeholder="The rule, written the way you'd write it for a new hire."
                      onChange={(md) => {
                        const procedures = [...editor.procedures]
                        procedures[index] = { ...editor.procedures[index]!, body: md }
                        setEditor({ ...editor, procedures })
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
                  {Object.entries(CATEGORY_LABELS).map(([category, label]) => (
                    <div key={category} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                      <span className="text-xs">{label}</span>
                      <Select
                        value={editor.autonomy[category] ?? 'approval'}
                        onChange={(e) => setEditor({ ...editor, autonomy: { ...editor.autonomy, [category]: e.target.value } })}
                        aria-label={label}
                      >
                        <option value="forbidden">forbidden</option>
                        <option value="approval">approval</option>
                        <option value="notify">notify</option>
                        <option value="trusted">trusted</option>
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
                  form.set('procedures', JSON.stringify(editor.procedures.map((p) => ({ ...p, slug: '' }))))
                  form.set('autonomyDefaults', JSON.stringify(editor.autonomy))
                  act(saveRoleDef, form, () => {
                    setEditor(null)
                    setSelected(null)
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
                      setSelected(null)
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
