import { index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@appkit/db'

/**
 * Procedures are the governed form of company doctrine: versioned SOPs that
 * hands provably follow and cite. A hand's context assembly loads the active
 * revision of every procedure assigned to it; run events record citations.
 */
export const procedureStatus = pgEnum('procedure_status', ['draft', 'active', 'retired'])

export type ProcedureAssignment = {
  /** Role-pack slugs this procedure binds to (every hand hired from the pack). */
  rolePacks?: string[]
  /** Specific people (hands) it binds to. */
  personIds?: string[]
  /** True = binds to every hand in the company. */
  everyone?: boolean
}

export type ProcedureSource =
  | { type: 'authored' }
  | { type: 'upload'; fileId: string }
  | { type: 'role-pack'; pack: string; procedure: string }

export const procedures = pgTable(
  'procedures',
  {
    id: id(),
    tenantId: tenantRef(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    status: procedureStatus('status').notNull().default('draft'),
    currentVersion: integer('current_version').notNull().default(1),
    assignment: jsonb('assignment').$type<ProcedureAssignment>().notNull().default({}),
    source: jsonb('source').$type<ProcedureSource>().notNull().default({ type: 'authored' }),
    ...auditColumns,
  },
  (t) => [uniqueIndex('procedures_tenant_slug_key').on(t.tenantId, t.slug)],
)

export const procedureRevisions = pgTable(
  'procedure_revisions',
  {
    id: id(),
    tenantId: tenantRef(),
    procedureId: uuid('procedure_id').notNull(),
    version: integer('version').notNull(),
    /** Markdown. The revision a hand followed is pinned by (procedureId, version). */
    body: text('body').notNull(),
    changeNote: text('change_note'),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('procedure_revisions_version_key').on(t.procedureId, t.version),
    index('procedure_revisions_tenant_idx').on(t.tenantId, t.procedureId),
  ],
)

export const PROCEDURES_TENANT_TABLES = ['procedures', 'procedure_revisions'] as const
