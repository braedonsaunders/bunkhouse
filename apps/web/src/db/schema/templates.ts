import { index, jsonb, pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@braedonsaunders/appkit-db'

/**
 * Reusable document templates — the company's own paperwork, authored once by
 * an operator and filled in by agents: engagement letters, quotes, inspection
 * reports, recurring workbooks.
 *
 * A template is authored structure, not free text an agent improvises: the
 * body carries `{{placeholders}}`, the declared merge-field list names them
 * for the model, and the renderer that produces the .docx / .pdf / .xlsx is
 * the same deterministic one every other deliverable goes through. The
 * placeholder list is reconciled from the body on every write (the procedures
 * rule — a derived list is re-derived on write so it can never drift).
 */
export const documentTemplateKind = pgEnum('document_template_kind', [
  /** `body` is authored HTML rendered onto company letterhead. */
  'document',
  /** `body` is a JSON sheet specification rendered to .xlsx. */
  'spreadsheet',
])

/** Output format for document templates. Spreadsheet templates are always .xlsx. */
export const documentTemplateFormat = pgEnum('document_template_format', ['docx', 'pdf'])

export const documentTemplateStatus = pgEnum('document_template_status', [
  /** Offered to agents. */
  'active',
  /** Kept for the record; agents no longer see it. */
  'archived',
])

/**
 * One merge field an agent is asked to supply. `name` is the placeholder token
 * as it appears in the body (`{{name}}`); the rest is guidance the model reads
 * so it fills the field with the right thing.
 */
export type TemplateMergeField = {
  name: string
  label: string
  description?: string
  example?: string
}

export const documentTemplates = pgTable(
  'document_templates',
  {
    id: id(),
    tenantId: tenantRef(),
    /** Stable handle agents name the template by; unique within the company. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    kind: documentTemplateKind('kind').notNull(),
    /** Document templates: sanitized authored HTML. Spreadsheets: a JSON sheet spec. */
    body: text('body').notNull(),
    /** Output format for document templates; ignored for spreadsheets (.xlsx). */
    defaultFormat: documentTemplateFormat('default_format').notNull().default('docx'),
    /** Reconciled against the placeholders found in `body` on every write. */
    mergeFields: jsonb('merge_fields').$type<TemplateMergeField[]>().notNull().default([]),
    status: documentTemplateStatus('status').notNull().default('active'),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('document_templates_slug_ux').on(t.tenantId, t.slug),
    index('document_templates_status_idx').on(t.tenantId, t.status, t.name),
  ],
)

export const TEMPLATES_TENANT_TABLES = ['document_templates'] as const
