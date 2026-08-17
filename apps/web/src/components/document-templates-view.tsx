'use client'

import * as React from 'react'
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  Input,
  Label,
  PagedTable,
  Select,
  SettingsRow,
  SettingsSection,
  Textarea,
  type PagedColumn,
} from '@appkit/ui'
import { RichTextEditor } from '@appkit/editor'
import {
  EXAMPLE_SHEET_SPEC,
  findPlaceholders,
  humanizeFieldName,
  parseSheetSpec,
  sheetSpecPlaceholders,
} from '../lib/template-merge'
import {
  generateFromTemplateAction,
  previewTemplateAction,
  saveTemplateAction,
  setTemplateStatusAction,
  type TemplatePreview,
} from '../app/admin/settings/template-actions'
import { SectionTabs } from './section-tabs'

/**
 * The template workspace: one list, and a flyout that holds the whole record —
 * the wording, the merge fields it exposes to agents, and a live preview of
 * what a filled copy looks like. Nothing here is a second source of truth: the
 * field list is derived from the body as it is typed, exactly as the server
 * re-derives it on save.
 */

export type TemplateMergeFieldView = {
  name: string
  label: string
  description?: string
  example?: string
}

export type TemplateRowView = {
  id: string
  slug: string
  name: string
  description: string
  kind: 'document' | 'spreadsheet'
  defaultFormat: 'docx' | 'pdf'
  status: 'active' | 'archived'
  body: string
  mergeFields: TemplateMergeFieldView[]
  produces: string
  fieldCount: number
  updatedAt: string
}

const COLUMNS: PagedColumn<TemplateRowView>[] = [
  {
    key: 'name',
    header: 'Template',
    cell: (row) => (
      <span className="min-w-0">
        <span className="block truncate font-medium text-primary">{row.name}</span>
        {row.description ? <span className="block truncate text-xs text-fg-muted">{row.description}</span> : null}
      </span>
    ),
    search: (row) => `${row.name} ${row.slug} ${row.description}`,
    sortValue: (row) => row.name,
  },
  {
    key: 'kind',
    header: 'Kind',
    cell: (row) => <Badge variant="outline">{row.kind === 'spreadsheet' ? 'Spreadsheet' : 'Document'}</Badge>,
    search: (row) => row.kind,
    sortValue: (row) => row.kind,
  },
  { key: 'produces', header: 'Produces', cell: (row) => row.produces, sortValue: (row) => row.produces },
  {
    key: 'fieldCount',
    header: 'Merge fields',
    align: 'right',
    cell: (row) => row.fieldCount,
    sortValue: (row) => row.fieldCount,
  },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => <Badge variant={row.status === 'active' ? 'default' : 'outline'}>{row.status}</Badge>,
    search: (row) => row.status,
    sortValue: (row) => row.status,
  },
  { key: 'updatedAt', header: 'Updated', cell: (row) => row.updatedAt, sortValue: (row) => row.updatedAt },
]

type Draft = {
  id: string | null
  name: string
  description: string
  kind: 'document' | 'spreadsheet'
  defaultFormat: 'docx' | 'pdf'
  body: string
  fields: TemplateMergeFieldView[]
}

const EMPTY_DOCUMENT_BODY =
  '<h1>Letter title</h1><p>Dear {{customer_name}},</p><p>Write the wording your company always uses, and leave a {{placeholder}} wherever the agent should fill something in.</p>'

function newDraft(kind: 'document' | 'spreadsheet'): Draft {
  return {
    id: null,
    name: '',
    description: '',
    kind,
    defaultFormat: 'docx',
    body: kind === 'spreadsheet' ? EXAMPLE_SHEET_SPEC : EMPTY_DOCUMENT_BODY,
    fields: [],
  }
}

function draftFromRow(row: TemplateRowView): Draft {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    defaultFormat: row.defaultFormat,
    body: row.body,
    fields: row.mergeFields,
  }
}

/** Placeholders in the draft as it stands, plus the reason a spec will not parse. */
function detectFields(draft: Draft): { names: string[]; error: string | null } {
  if (draft.kind !== 'spreadsheet') return { names: findPlaceholders(draft.body), error: null }
  try {
    return { names: sheetSpecPlaceholders(parseSheetSpec(draft.body)), error: null }
  } catch (error) {
    return { names: [], error: error instanceof Error ? error.message : String(error) }
  }
}

export function DocumentTemplatesView({ rows }: { rows: TemplateRowView[] }) {
  const [draft, setDraft] = React.useState<Draft | null>(null)
  const [editorKey, setEditorKey] = React.useState(0)
  const [tab, setTab] = React.useState('template')
  const [values, setValues] = React.useState<Record<string, string>>({})
  const [preview, setPreview] = React.useState<TemplatePreview | null>(null)
  const [generated, setGenerated] = React.useState<{ fileId: string; filename: string } | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const detected = draft ? detectFields(draft) : { names: [], error: null }
  const current = draft?.id ? (rows.find((row) => row.id === draft.id) ?? null) : null

  const open = (next: Draft) => {
    setDraft(next)
    setEditorKey((key) => key + 1)
    setTab('template')
    setValues(Object.fromEntries(next.fields.map((field) => [field.name, field.example ?? ''])))
    setPreview(null)
    setGenerated(null)
    setNotice(null)
    setError(null)
  }

  const close = () => {
    setDraft(null)
    setPreview(null)
    setGenerated(null)
  }

  const patch = (change: Partial<Draft>) => setDraft((prev) => (prev ? { ...prev, ...change } : prev))

  const fieldMeta = (name: string): TemplateMergeFieldView =>
    draft?.fields.find((field) => field.name === name) ?? { name, label: humanizeFieldName(name) }

  const setFieldMeta = (name: string, change: Partial<TemplateMergeFieldView>) =>
    setDraft((prev) => {
      if (!prev) return prev
      const existing = prev.fields.find((field) => field.name === name)
      const merged: TemplateMergeFieldView = { ...fieldMeta(name), ...existing, ...change }
      return {
        ...prev,
        fields: [...prev.fields.filter((field) => field.name !== name), merged],
      }
    })

  const save = async () => {
    if (!draft) return
    setBusy(true)
    setError(null)
    setNotice(null)
    const result = await saveTemplateAction({
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name,
      description: draft.description,
      kind: draft.kind,
      body: draft.body,
      defaultFormat: draft.defaultFormat,
      mergeFields: detected.names.map((name) => fieldMeta(name)),
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setDraft((prev) => (prev ? { ...prev, id: result.id } : prev))
    setNotice('Saved. Agents see this template the next time they look.')
  }

  const runPreview = async () => {
    if (!draft) return
    setBusy(true)
    setError(null)
    const result = await previewTemplateAction({
      name: draft.name,
      kind: draft.kind,
      body: draft.body,
      values,
    })
    setBusy(false)
    setPreview(result)
    if (!result.ok) setError(result.message)
  }

  const generate = async () => {
    if (!draft?.id) return
    setBusy(true)
    setError(null)
    setNotice(null)
    const result = await generateFromTemplateAction({ id: draft.id, values })
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setGenerated({ fileId: result.fileId, filename: result.filename })
    setNotice(
      result.unfilled.length > 0
        ? `Created ${result.filename}. ${result.unfilled.length} placeholder${result.unfilled.length === 1 ? '' : 's'} had no value and are still visible in the file.`
        : `Created ${result.filename}.`,
    )
  }

  const changeStatus = async (status: 'active' | 'archived') => {
    if (!draft?.id) return
    setBusy(true)
    setError(null)
    const result = await setTemplateStatusAction({ id: draft.id, status })
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setNotice(status === 'archived' ? 'Archived. Agents no longer see this template.' : 'Restored.')
  }

  return (
    <div className="space-y-4">
      <SettingsSection
        title="Document templates"
        description="The paperwork your company sends every week — an engagement letter, a quote, an inspection report. Agents fill a template in instead of composing from scratch, and the merge fields are derived from the wording itself."
      >
        <SettingsRow
          title="Your templates"
          description="Open one to edit its wording, its merge fields, and a live preview of a filled copy."
          control={
            <span className="flex gap-2">
              <Button size="sm" onClick={() => open(newDraft('document'))}>
                New document template
              </Button>
              <Button size="sm" variant="outline" onClick={() => open(newDraft('spreadsheet'))}>
                New spreadsheet template
              </Button>
            </span>
          }
        />
        <div className="px-5 py-4">
          <PagedTable
            columns={COLUMNS}
            rows={rows}
            rowKey={(row) => row.id}
            pageSize={10}
            searchable
            defaultSort={{ key: 'updatedAt', dir: 'desc' }}
            onRowClick={(row) => open(draftFromRow(row))}
            labels={{ searchPlaceholder: 'Search templates…', searchLabel: 'Search templates' }}
            empty={
              <EmptyState
                title="No templates yet"
                description="Write the paperwork your company sends every week and agents fill it in instead of composing from scratch."
                action={<Button onClick={() => open(newDraft('document'))}>New document template</Button>}
              />
            }
          />
        </div>
      </SettingsSection>

      <Drawer
        open={draft !== null}
        onClose={close}
        size="xl"
        title={draft?.id ? draft.name || 'Template' : 'New template'}
        description={
          draft?.kind === 'spreadsheet'
            ? 'A spreadsheet template renders to .xlsx from a sheet specification.'
            : 'A document template renders to .docx or .pdf on the company letterhead.'
        }
        headerActions={
          current ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => changeStatus(current.status === 'active' ? 'archived' : 'active')}
            >
              {current.status === 'active' ? 'Archive' : 'Restore'}
            </Button>
          ) : null
        }
        subtabs={
          <SectionTabs
            tabs={[
              { key: 'template', label: 'Template' },
              { key: 'fields', label: 'Merge fields', count: detected.names.length },
              { key: 'preview', label: 'Preview' },
            ]}
            active={tab}
            onSelect={setTab}
            ariaLabel="Template sections"
          />
        }
        footer={
          <div className="flex w-full items-center justify-between gap-3">
            <span className="text-sm">
              {error ? <span className="text-danger">{error}</span> : null}
              {!error && notice ? <span className="text-fg-muted">{notice}</span> : null}
            </span>
            <span className="flex gap-2">
              <Button variant="outline" onClick={close} disabled={busy}>
                Close
              </Button>
              <Button onClick={save} disabled={busy || !draft?.name.trim()}>
                {draft?.id ? 'Save changes' : 'Create template'}
              </Button>
            </span>
          </div>
        }
      >
        {draft ? (
          <div className="space-y-4">
            {tab === 'template' ? (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="template-name">Name</Label>
                    <Input
                      id="template-name"
                      value={draft.name}
                      onChange={(event) => patch({ name: event.target.value })}
                      placeholder="Engagement letter"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="template-format">Produces</Label>
                    {draft.kind === 'spreadsheet' ? (
                      <p className="pt-2 text-sm text-fg-muted">Excel workbook (.xlsx)</p>
                    ) : (
                      <Select
                        id="template-format"
                        value={draft.defaultFormat}
                        onChange={(event) =>
                          patch({ defaultFormat: event.target.value === 'pdf' ? 'pdf' : 'docx' })
                        }
                      >
                        <option value="docx">Word document (.docx)</option>
                        <option value="pdf">PDF (.pdf)</option>
                      </Select>
                    )}
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="template-description">When to use it</Label>
                  <Input
                    id="template-description"
                    value={draft.description}
                    onChange={(event) => patch({ description: event.target.value })}
                    placeholder="Agents read this when choosing a template — say what job it is for."
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="template-body">{draft.kind === 'spreadsheet' ? 'Sheet specification' : 'Document'}</Label>
                  {draft.kind === 'spreadsheet' ? (
                    <>
                      <Textarea
                        id="template-body"
                        value={draft.body}
                        onChange={(event) => patch({ body: event.target.value })}
                        rows={18}
                        className="font-mono text-xs"
                      />
                      <p className="text-xs text-fg-muted">
                        Columns, rows and formulas in JSON. Put {'{{placeholders}}'} in any cell, header or formula —
                        a cell that is only a placeholder becomes a real number when the value is one, so formats and
                        formulas keep working.
                      </p>
                    </>
                  ) : (
                    <>
                      <RichTextEditor
                        key={editorKey}
                        defaultValue={draft.body}
                        onChange={(html) => patch({ body: html })}
                        minHeight="22rem"
                        placeholder="Write the letter as you would send it, with {{placeholders}} for the parts that change."
                        normalizeLink={(value) => {
                          const trimmed = value.trim()
                          if (!trimmed) return null
                          if (/^https?:\/\//i.test(trimmed)) return trimmed
                          if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(trimmed)) return `mailto:${trimmed}`
                          return `https://${trimmed}`
                        }}
                      />
                      <p className="text-xs text-fg-muted">
                        The company letterhead, accent color and footer come from Settings → Documents and are applied
                        at render time — do not repeat them here.
                      </p>
                    </>
                  )}
                </div>
                {detected.error ? <p className="text-sm text-danger">{detected.error}</p> : null}
              </div>
            ) : null}

            {tab === 'fields' ? (
              <div className="space-y-4">
                <p className="text-sm text-fg-muted">
                  Every {'{{placeholder}}'} in the template becomes a merge field an agent must supply. Name them
                  plainly and give an example — that text is what the agent reads before filling the template in.
                </p>
                {detected.error ? <p className="text-sm text-danger">{detected.error}</p> : null}
                {detected.names.length === 0 && !detected.error ? (
                  <p className="text-sm text-fg-muted">
                    No placeholders yet. Add {'{{customer_name}}'} — or any name you like — to the template.
                  </p>
                ) : null}
                {detected.names.map((name) => {
                  const meta = fieldMeta(name)
                  return (
                    <div key={name} className="rounded-md border border-border p-3">
                      <div className="mb-2 flex items-center gap-2">
                        <Badge variant="secondary">{`{{${name}}}`}</Badge>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1">
                          <Label htmlFor={`field-label-${name}`}>Label</Label>
                          <Input
                            id={`field-label-${name}`}
                            value={meta.label}
                            onChange={(event) => setFieldMeta(name, { label: event.target.value })}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`field-example-${name}`}>Example value</Label>
                          <Input
                            id={`field-example-${name}`}
                            value={meta.example ?? ''}
                            onChange={(event) => setFieldMeta(name, { example: event.target.value })}
                            placeholder="Acme Roofing"
                          />
                        </div>
                        <div className="space-y-1 sm:col-span-2">
                          <Label htmlFor={`field-description-${name}`}>Guidance for the agent</Label>
                          <Input
                            id={`field-description-${name}`}
                            value={meta.description ?? ''}
                            onChange={(event) => setFieldMeta(name, { description: event.target.value })}
                            placeholder="The legal name of the customer, as it appears on the contract."
                          />
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : null}

            {tab === 'preview' ? (
              <div className="space-y-4">
                <p className="text-sm text-fg-muted">
                  Fill the fields and render the template exactly as an agent would. Anything left blank stays visible
                  in the output as its placeholder — that is deliberate, so an unfinished document is obvious.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {detected.names.map((name) => (
                    <div key={name} className="space-y-1">
                      <Label htmlFor={`value-${name}`}>{fieldMeta(name).label}</Label>
                      <Input
                        id={`value-${name}`}
                        value={values[name] ?? ''}
                        onChange={(event) => setValues((prev) => ({ ...prev, [name]: event.target.value }))}
                        placeholder={fieldMeta(name).example ?? ''}
                      />
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="outline" onClick={runPreview} disabled={busy}>
                    Render preview
                  </Button>
                  {draft.id ? (
                    <Button variant="outline" onClick={generate} disabled={busy}>
                      Create a real file
                    </Button>
                  ) : null}
                  {generated ? (
                    <a
                      className="text-sm text-primary underline underline-offset-4"
                      href={`/api/files/${generated.fileId}`}
                    >
                      Download {generated.filename}
                    </a>
                  ) : null}
                </div>
                {preview?.ok && preview.unfilled.length > 0 ? (
                  <p className="text-sm text-fg-muted">
                    Still unfilled: {preview.unfilled.map((name) => `{{${name}}}`).join(', ')}
                  </p>
                ) : null}
                {preview?.ok && preview.kind === 'document' ? (
                  <iframe
                    title="Template preview"
                    srcDoc={preview.html}
                    sandbox=""
                    className="h-[30rem] w-full rounded-md border border-border"
                  />
                ) : null}
                {preview?.ok && preview.kind === 'spreadsheet'
                  ? preview.sheets.map((sheet) => (
                      <div key={sheet.name} className="space-y-1">
                        <p className="text-sm font-medium">{sheet.name}</p>
                        <div className="overflow-x-auto rounded-md border border-border">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-border text-left">
                                {sheet.headers.map((header) => (
                                  <th key={header} className="px-3 py-2 font-medium">
                                    {header}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {sheet.rows.map((row, rowIndex) => (
                                <tr key={rowIndex} className="border-b border-border last:border-b-0">
                                  {row.map((cell, cellIndex) => (
                                    <td key={cellIndex} className="px-3 py-2 text-fg-muted">
                                      {cell === null ? '' : String(cell)}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))
                  : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </div>
  )
}
