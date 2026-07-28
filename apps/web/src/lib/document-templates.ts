import 'server-only'
import { and, asc, eq, ne } from 'drizzle-orm'
import { z } from 'zod'
import { defineAbility, type Ability } from '@bunkhouse/runtime'
import { htmlToDocx, htmlToPdf, officeDocumentHtml, renderWorkbook, sanitizeOfficeHtml } from '@appkit/office'
import { people } from '../db/schema'
import {
  documentTemplates,
  type documentTemplateFormat,
  type documentTemplateKind,
  type documentTemplateStatus,
  type TemplateMergeField,
} from '../db/schema/templates'
import { db } from '../db/client'
import { saveFile, type FileRecord } from './files'
import { getDocumentBranding } from './documents'
import { fileDeliverable } from './filing'
import {
  findPlaceholders,
  humanizeFieldName,
  mergeHtml,
  mergeSheetSpec,
  parseSheetSpec,
  sheetSpecPlaceholders,
  type TemplateWorkbook,
} from './template-merge'

/**
 * Per-tenant document templates: the company's own paperwork, authored once
 * by an operator and filled in by an agent.
 *
 * The same deterministic renderers every other deliverable goes through
 * produce the bytes — a template only decides the words and the structure, so
 * a filled template is indistinguishable from any other work product in the
 * files ledger. Placeholders that nothing filled survive into the output on
 * purpose and are reported back to the agent: a document that looks finished
 * and is not would be the worst possible failure mode here.
 *
 * Like procedures, the derived half of the record is re-derived on every
 * write (`mergeFields` from the body, the body from its own parsed form), so
 * what an operator sees and what an agent fills can never drift apart.
 */

type PersonRow = typeof people.$inferSelect

export type DocumentTemplateRow = typeof documentTemplates.$inferSelect
export type DocumentTemplateKind = (typeof documentTemplateKind.enumValues)[number]
export type DocumentTemplateFormat = (typeof documentTemplateFormat.enumValues)[number]
export type DocumentTemplateStatus = (typeof documentTemplateStatus.enumValues)[number]

export type { TemplateMergeField }

/** What an agent is told about a template it could use. */
export type TemplateSummary = {
  slug: string
  name: string
  description: string
  kind: DocumentTemplateKind
  /** '.docx' / '.pdf' for documents, '.xlsx' for spreadsheets. */
  produces: string
  mergeFields: TemplateMergeField[]
}

// --- Authoring --------------------------------------------------------------

/** URL-safe handle derived from the template name. */
export function templateSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'template'
  )
}

/**
 * The stored body, normalized for its kind: document HTML is reduced to the
 * printable allowlist the renderer accepts, and a sheet specification is
 * re-serialized from its parsed form. What is stored is exactly what renders.
 */
export function normalizeTemplateBody(kind: DocumentTemplateKind, body: string): string {
  if (kind === 'spreadsheet') return JSON.stringify(parseSheetSpec(body), null, 2)
  const html = sanitizeOfficeHtml(body).trim()
  if (!html) throw new Error('The template body is empty. Write the document before saving it.')
  return html
}

/** Every placeholder a stored body contains, whatever its kind. */
export function templatePlaceholders(kind: DocumentTemplateKind, body: string): string[] {
  return kind === 'spreadsheet' ? sheetSpecPlaceholders(parseSheetSpec(body)) : findPlaceholders(body)
}

/**
 * Reconcile the declared merge-field list against the placeholders actually in
 * the body: fields that disappeared from the body are dropped, new ones are
 * added with a readable label, and the order follows the document. The list an
 * agent reads is therefore always the list the template really has.
 */
export function reconcileMergeFields(
  kind: DocumentTemplateKind,
  body: string,
  declared: TemplateMergeField[],
): TemplateMergeField[] {
  return templatePlaceholders(kind, body).map((name) => {
    const existing = declared.find((field) => field.name === name)
    return {
      name,
      label: existing?.label?.trim() || humanizeFieldName(name),
      ...(existing?.description?.trim() ? { description: existing.description.trim() } : {}),
      ...(existing?.example?.trim() ? { example: existing.example.trim() } : {}),
    }
  })
}

export type SaveTemplateInput = {
  tenantId: string
  /** Omitted when creating. */
  id?: string
  name: string
  description: string
  kind: DocumentTemplateKind
  body: string
  defaultFormat: DocumentTemplateFormat
  mergeFields: TemplateMergeField[]
  slug?: string
}

/** Create or replace a template. Slug collisions are reported, never silently resolved. */
export async function saveDocumentTemplate(input: SaveTemplateInput): Promise<DocumentTemplateRow> {
  const name = input.name.trim()
  if (!name) throw new Error('Give the template a name.')
  const slug = templateSlug(input.slug?.trim() || name)
  const body = normalizeTemplateBody(input.kind, input.body)
  const mergeFields = reconcileMergeFields(input.kind, body, input.mergeFields)
  const app = db()
  return app.withTenant(input.tenantId, async () => {
    const clash = await app.db
      .select({ id: documentTemplates.id })
      .from(documentTemplates)
      .where(
        input.id
          ? and(eq(documentTemplates.slug, slug), ne(documentTemplates.id, input.id))
          : eq(documentTemplates.slug, slug),
      )
    if (clash.length > 0) throw new Error(`Another template already uses the handle "${slug}". Rename this one.`)

    const values = {
      slug,
      name,
      description: input.description.trim(),
      kind: input.kind,
      body,
      defaultFormat: input.defaultFormat,
      mergeFields,
    }
    if (input.id) {
      const [row] = await app.db
        .update(documentTemplates)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(documentTemplates.id, input.id))
        .returning()
      if (!row) throw new Error('That template no longer exists.')
      return row
    }
    const [row] = await app.db
      .insert(documentTemplates)
      .values({ tenantId: input.tenantId, ...values })
      .returning()
    if (!row) throw new Error('The template could not be created.')
    return row
  })
}

/** Archive or restore a template. Archived templates are invisible to agents. */
export async function setDocumentTemplateStatus(
  tenantId: string,
  id: string,
  status: DocumentTemplateStatus,
): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .update(documentTemplates)
      .set({ status, updatedAt: new Date() })
      .where(eq(documentTemplates.id, id))
  })
}

/** Every template in the company, newest naming order, for the operator surface. */
export async function listDocumentTemplates(tenantId: string): Promise<DocumentTemplateRow[]> {
  const app = db()
  return app.withTenantContext(tenantId, () =>
    app.db.select().from(documentTemplates).orderBy(asc(documentTemplates.name)),
  )
}

/** The active templates an agent may use. */
export async function listActiveTemplates(tenantId: string): Promise<DocumentTemplateRow[]> {
  const app = db()
  return app.withTenantContext(tenantId, () =>
    app.db
      .select()
      .from(documentTemplates)
      .where(eq(documentTemplates.status, 'active'))
      .orderBy(asc(documentTemplates.name)),
  )
}

export async function getDocumentTemplate(tenantId: string, id: string): Promise<DocumentTemplateRow | null> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [row] = await app.db.select().from(documentTemplates).where(eq(documentTemplates.id, id))
    return row ?? null
  })
}

export async function getDocumentTemplateBySlug(
  tenantId: string,
  slug: string,
): Promise<DocumentTemplateRow | null> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [row] = await app.db.select().from(documentTemplates).where(eq(documentTemplates.slug, slug))
    return row ?? null
  })
}

export function templateSummary(row: DocumentTemplateRow): TemplateSummary {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    kind: row.kind,
    produces: row.kind === 'spreadsheet' ? '.xlsx' : `.${row.defaultFormat}`,
    mergeFields: row.mergeFields,
  }
}

// --- Rendering --------------------------------------------------------------

/**
 * The exact HTML the .docx / .pdf converter receives — merged, sanitized, and
 * wrapped in the company letterhead. The authoring surface previews this same
 * string, so an operator sees what an agent will send.
 */
export async function renderTemplateHtml(args: {
  tenantId: string
  template: Pick<DocumentTemplateRow, 'name' | 'body'>
  values: Record<string, string>
  title?: string
}): Promise<{ html: string; unfilled: string[] }> {
  const merged = mergeHtml(args.template.body, args.values)
  const html = officeDocumentHtml({
    bodyHtml: sanitizeOfficeHtml(merged.value),
    title: args.title?.trim() || args.template.name,
    branding: await getDocumentBranding(args.tenantId),
  })
  return { html, unfilled: merged.unfilled }
}

/** The merged sheet specification a spreadsheet template renders from. */
export function renderTemplateWorkbook(args: {
  template: Pick<DocumentTemplateRow, 'body'>
  values: Record<string, string>
}): { workbook: TemplateWorkbook; unfilled: string[] } {
  const merged = mergeSheetSpec(parseSheetSpec(args.template.body), args.values)
  return { workbook: merged.value, unfilled: merged.unfilled }
}

function safeFilename(name: string, extension: string): string {
  const base =
    name
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^a-zA-Z0-9 _-]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'document'
  return `${base}.${extension}`
}

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * Fill a template and file the result in the ledger — the one path both the
 * agent ability and any future operator-side "generate from template" action
 * share.
 */
export async function createFileFromTemplate(args: {
  tenantId: string
  template: DocumentTemplateRow
  values: Record<string, string>
  personId?: string | null
  runId?: string | null
  creator?: string
  format?: DocumentTemplateFormat
  filename?: string
  title?: string
}): Promise<{ record: FileRecord; unfilled: string[] }> {
  const { tenantId, template, values } = args
  if (template.kind === 'spreadsheet') {
    const { workbook, unfilled } = renderTemplateWorkbook({ template, values })
    const bytes = await renderWorkbook({
      ...(args.creator ? { creator: args.creator } : {}),
      sheets: workbook.sheets,
    })
    const record = await saveFile({
      tenantId,
      personId: args.personId ?? null,
      runId: args.runId ?? null,
      kind: 'spreadsheet',
      filename: safeFilename(args.filename ?? args.title ?? template.name, 'xlsx'),
      contentType: XLSX_TYPE,
      bytes,
    })
    return { record, unfilled }
  }

  const format = args.format ?? template.defaultFormat
  const { html, unfilled } = await renderTemplateHtml({
    tenantId,
    template,
    values,
    ...(args.title ? { title: args.title } : {}),
  })
  const bytes = format === 'docx' ? await htmlToDocx(html) : await htmlToPdf(html)
  const record = await saveFile({
    tenantId,
    personId: args.personId ?? null,
    runId: args.runId ?? null,
    kind: 'document',
    filename: safeFilename(args.filename ?? args.title ?? template.name, format),
    contentType: format === 'docx' ? DOCX_TYPE : 'application/pdf',
    bytes,
  })
  return { record, unfilled }
}

// --- Abilities --------------------------------------------------------------

/**
 * The template half of an agent's document toolbox. Listing is ungoverned —
 * reading the company's stationery cupboard changes nothing — while producing
 * a file carries `file_write`, exactly like `create_document`.
 */
export function templateAbilities(args: { tenantId: string; person: PersonRow; runId: string }): Ability[] {
  const { tenantId, person, runId } = args
  return [
    defineAbility({
      name: 'list_document_templates',
      description:
        "The company's reusable document and spreadsheet templates — approved wording an operator has already written. Check here before authoring a document from scratch: if a template fits the job, fill it instead. Each template lists the merge fields you must supply.",
      category: null,
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await listActiveTemplates(tenantId)
        return {
          templates: rows.map(templateSummary),
          ...(rows.length === 0
            ? { note: 'No templates are set up. Author the document yourself with create_document.' }
            : {}),
        }
      },
    }),
    defineAbility({
      name: 'create_document_from_template',
      description:
        'Produce a finished file from one of the company templates: supply a value for every merge field the template lists and the deterministic renderer does the rest, on company letterhead. Returns the file id — attach it to an email with attachFileIds. Any field you leave out stays visible in the file as {{field_name}} and is reported back to you, so check the result before sending it to anyone.',
      category: 'file_write',
      inputSchema: z.object({
        slug: z.string().describe('The template handle from list_document_templates'),
        values: z
          .record(z.string(), z.string())
          .describe('Merge field name → the value to fill in, e.g. { "customer_name": "Acme Roofing" }'),
        format: z
          .enum(['docx', 'pdf'])
          .optional()
          .describe("Document templates only; defaults to the template's own format. Spreadsheets are always .xlsx."),
        filename: z.string().optional().describe('Without extension; defaults to the template name'),
        title: z.string().optional().describe('Overrides the letterhead title for this one document'),
      }),
      execute: async ({ slug, values, format, filename, title }) => {
        const template = await getDocumentTemplateBySlug(tenantId, slug)
        if (!template || template.status !== 'active') {
          const available = (await listActiveTemplates(tenantId)).map((row) => row.slug)
          return {
            error: `No active template named "${slug}".`,
            available,
          }
        }
        const { record, unfilled } = await createFileFromTemplate({
          tenantId,
          template,
          values,
          personId: person.id,
          runId,
          creator: person.name,
          ...(format ? { format } : {}),
          ...(filename ? { filename } : {}),
          ...(title ? { title } : {}),
        })
        const filed = await fileDeliverable({ tenantId, record })
        return {
          fileId: record.id,
          filename: record.filename,
          sizeBytes: record.sizeBytes,
          template: template.slug,
          ...(unfilled.length > 0
            ? {
                unfilledPlaceholders: unfilled,
                warning: `These merge fields had no value and are still visible in the file as placeholders: ${unfilled
                  .map((name) => `{{${name}}}`)
                  .join(', ')}. Fill them and produce the file again before sending it.`,
              }
            : {}),
          ...(filed.filed && filed.location ? { filedTo: filed.location } : {}),
        }
      },
    }),
  ]
}
