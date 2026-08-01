'use server'

import { revalidatePath } from 'next/cache'
import { resolveTenantId as resolveTenant } from '../../../lib/tenant'
const resolveTenantId = () => resolveTenant('settings.manage')
import {
  createFileFromTemplate,
  getDocumentTemplate,
  normalizeTemplateBody,
  renderTemplateHtml,
  renderTemplateWorkbook,
  saveDocumentTemplate,
  setDocumentTemplateStatus,
  type DocumentTemplateFormat,
  type DocumentTemplateKind,
  type DocumentTemplateStatus,
  type TemplateMergeField,
} from '../../../lib/document-templates'

/**
 * Server actions for the document-template workspace. Everything an operator
 * does here is tenant-scoped through `resolveTenantId`, which validates the
 * session before any template is read or written.
 */

// Settings is one screen with sections, not a page per section — a path like
// `/admin/settings/templates` resolves to no route at all, so this refreshed
// nothing and the page went on rendering what it had.
const TEMPLATES_PATH = '/admin/settings'

function failure(error: unknown): { ok: false; message: string } {
  return { ok: false, message: error instanceof Error ? error.message : String(error) }
}

export type TemplateActionResult = { ok: true; id: string } | { ok: false; message: string }

export async function saveTemplateAction(input: {
  id?: string
  name: string
  description: string
  kind: DocumentTemplateKind
  body: string
  defaultFormat: DocumentTemplateFormat
  mergeFields: TemplateMergeField[]
  slug?: string
}): Promise<TemplateActionResult> {
  try {
    const tenantId = await resolveTenantId()
    const row = await saveDocumentTemplate({
      tenantId,
      ...(input.id ? { id: input.id } : {}),
      name: input.name,
      description: input.description,
      kind: input.kind,
      body: input.body,
      defaultFormat: input.defaultFormat,
      mergeFields: input.mergeFields,
      ...(input.slug ? { slug: input.slug } : {}),
    })
    revalidatePath(TEMPLATES_PATH)
    return { ok: true, id: row.id }
  } catch (error) {
    return failure(error)
  }
}

export async function setTemplateStatusAction(input: {
  id: string
  status: DocumentTemplateStatus
}): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const tenantId = await resolveTenantId()
    await setDocumentTemplateStatus(tenantId, input.id, input.status)
    revalidatePath(TEMPLATES_PATH)
    return { ok: true }
  } catch (error) {
    return failure(error)
  }
}

export type TemplatePreview =
  | { ok: true; kind: 'document'; html: string; unfilled: string[] }
  | {
      ok: true
      kind: 'spreadsheet'
      sheets: { name: string; headers: string[]; rows: (string | number | boolean | null)[][] }[]
      unfilled: string[]
    }
  | { ok: false; message: string }

/**
 * Render the template exactly as an agent would, from the draft in the
 * editor — for documents this is the very HTML handed to the .docx / .pdf
 * converter, so what an operator previews is what a recipient receives.
 */
export async function previewTemplateAction(input: {
  name: string
  kind: DocumentTemplateKind
  body: string
  values: Record<string, string>
}): Promise<TemplatePreview> {
  try {
    const tenantId = await resolveTenantId()
    const body = normalizeTemplateBody(input.kind, input.body)
    if (input.kind === 'spreadsheet') {
      const { workbook, unfilled } = renderTemplateWorkbook({ template: { body }, values: input.values })
      return {
        ok: true,
        kind: 'spreadsheet',
        unfilled,
        sheets: workbook.sheets.map((sheet) => ({
          name: sheet.name,
          headers: sheet.columns.map((column) => column.header),
          rows: sheet.rows.map((row) => sheet.columns.map((column) => row[column.key] ?? null)),
        })),
      }
    }
    const { html, unfilled } = await renderTemplateHtml({
      tenantId,
      template: { name: input.name || 'Untitled template', body },
      values: input.values,
    })
    return { ok: true, kind: 'document', html, unfilled }
  } catch (error) {
    return failure(error)
  }
}

/**
 * Produce a real file from a saved template and put it in the company file
 * record — the operator's own copy of what an agent would send, downloadable
 * from the returned link.
 */
export async function generateFromTemplateAction(input: {
  id: string
  values: Record<string, string>
}): Promise<{ ok: true; fileId: string; filename: string; unfilled: string[] } | { ok: false; message: string }> {
  try {
    const tenantId = await resolveTenantId()
    const template = await getDocumentTemplate(tenantId, input.id)
    if (!template) return { ok: false, message: 'That template no longer exists.' }
    const { record, unfilled } = await createFileFromTemplate({ tenantId, template, values: input.values })
    revalidatePath(TEMPLATES_PATH)
    return { ok: true, fileId: record.id, filename: record.filename, unfilled }
  } catch (error) {
    return failure(error)
  }
}
