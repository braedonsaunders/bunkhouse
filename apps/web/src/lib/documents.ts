import 'server-only'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { defineAbility, type Ability } from '@bunkhouse/runtime'
import {
  htmlToDocx,
  htmlToPdf,
  officeDocumentHtml,
  renderWorkbook,
  sanitizeOfficeHtml,
  type WorkbookSpec,
} from '@appkit/office'
import { people, tenantSettings, DOCUMENT_BRANDING_KEY, type DocumentBrandingSettings } from '../db/schema'
import { db } from '../db/client'
import { saveFile } from './files'
import { readLedgeredFile, reviseDocxFile } from './file-reading'
import { fileDeliverable } from './filing'

/**
 * Office deliverables: the agent authors clean HTML (documents) or a sheet
 * spec (spreadsheets); deterministic renderers produce the real .docx / .pdf /
 * .xlsx bytes with the tenant's letterhead. The model never touches OOXML.
 */

type PersonRow = typeof people.$inferSelect

export async function getDocumentBranding(tenantId: string): Promise<DocumentBrandingSettings> {
  const app = db()
  const [row] = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ value: tenantSettings.value })
      .from(tenantSettings)
      .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, DOCUMENT_BRANDING_KEY))),
  )
  return (row?.value as DocumentBrandingSettings | undefined) ?? {}
}

export async function saveDocumentBranding(tenantId: string, value: DocumentBrandingSettings): Promise<void> {
  const app = db()
  await app.db
    .insert(tenantSettings)
    .values({ tenantId, key: DOCUMENT_BRANDING_KEY, value })
    .onConflictDoUpdate({
      target: [tenantSettings.tenantId, tenantSettings.key],
      set: { value, updatedAt: new Date() },
    })
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

const sheetSpecSchema = z.object({
  name: z.string().describe('Sheet tab name'),
  columns: z
    .array(
      z.object({
        header: z.string(),
        key: z.string().describe('Row-object key this column reads'),
        width: z.number().optional(),
        numFmt: z.string().optional().describe('Excel number format, e.g. "$#,##0.00" or "0.0%"'),
      }),
    )
    .min(1),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  formulas: z
    .array(z.object({ cell: z.string().describe('e.g. D12'), formula: z.string().describe('e.g. SUM(D2:D11)') }))
    .optional(),
  autoFilter: z.boolean().optional(),
})

export function documentAbilities(args: { tenantId: string; person: PersonRow; runId: string }): Ability[] {
  const { tenantId, person, runId } = args
  return [
    defineAbility({
      name: 'create_document',
      description:
        'Produce a finished document file (.docx or .pdf) from HTML you write, on company letterhead. Allowed tags: h1-h4, p, ul/ol/li, strong/em/u, blockquote, table/thead/tbody/tr/th/td, a, br, hr. Returns the file id — attach it to an email with attachFileIds, or reference it later. Write complete, polished content: this file goes to a real recipient.',
      category: 'file_write',
      inputSchema: z.object({
        title: z.string().describe('Document title, shown on the letterhead'),
        format: z.enum(['docx', 'pdf']),
        bodyHtml: z.string().describe('The full document body as clean HTML'),
        filename: z.string().optional().describe('Without extension; defaults to the title'),
      }),
      execute: async ({ title, format, bodyHtml, filename }) => {
        const html = officeDocumentHtml({
          bodyHtml: sanitizeOfficeHtml(bodyHtml),
          title,
          branding: await getDocumentBranding(tenantId),
        })
        const bytes = format === 'docx' ? await htmlToDocx(html) : await htmlToPdf(html)
        const record = await saveFile({
          tenantId,
          personId: person.id,
          runId,
          kind: 'document',
          filename: safeFilename(filename ?? title, format),
          contentType:
            format === 'docx'
              ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
              : 'application/pdf',
          bytes,
        })
        // Filing is the extra copy: it never throws and never blocks delivery.
        await fileDeliverable({ tenantId, record, bytes })
        return { fileId: record.id, filename: record.filename, sizeBytes: record.sizeBytes }
      },
    }),
    defineAbility({
      name: 'create_spreadsheet',
      description:
        'Produce a finished spreadsheet file (.xlsx) from a sheet specification: columns (with optional Excel number formats), data rows, and optional formulas. Returns the file id — attach it to an email with attachFileIds. Use real numbers (not preformatted strings) so formats and formulas work.',
      category: 'file_write',
      inputSchema: z.object({
        title: z.string(),
        sheets: z.array(sheetSpecSchema).min(1),
        filename: z.string().optional().describe('Without extension; defaults to the title'),
      }),
      execute: async ({ title, sheets, filename }) => {
        const spec: WorkbookSpec = { creator: person.name, sheets }
        const bytes = await renderWorkbook(spec)
        const record = await saveFile({
          tenantId,
          personId: person.id,
          runId,
          kind: 'spreadsheet',
          filename: safeFilename(filename ?? title, 'xlsx'),
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          bytes,
        })
        // Filing is the extra copy: it never throws and never blocks delivery.
        await fileDeliverable({ tenantId, record, bytes })
        return { fileId: record.id, filename: record.filename, sizeBytes: record.sizeBytes }
      },
    }),
    defineAbility({
      name: 'read_file',
      description:
        'Read a file from the company file record by its file id — mail attachments people sent you, documents you produced, anything ledgered. Extracts the text of .docx, .pdf, .xlsx, and plain-text formats. Use it to understand what you were sent before acting on it, and to re-read your own rendered deliverable before sending it.',
      category: null,
      inputSchema: z.object({ fileId: z.string() }),
      execute: async ({ fileId }) => readLedgeredFile(tenantId, fileId),
    }),
    defineAbility({
      name: 'revise_document',
      description:
        'Revise an existing .docx file with exact find-and-replace edits (formatting survives). Read the file first and use exact text for `find` — an edit that matches nothing is reported back so you can retry. Produces a new revision file; the original is kept.',
      category: 'file_write',
      inputSchema: z.object({
        fileId: z.string(),
        edits: z
          .array(z.object({ find: z.string(), replace: z.string() }))
          .min(1)
          .max(20),
      }),
      execute: async ({ fileId, edits }) => reviseDocxFile({ tenantId, personId: person.id, runId, fileId, edits }),
    }),
  ]
}
