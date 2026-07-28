import { index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@appkit/db'

/**
 * Procedures are the governed form of company doctrine: versioned SOPs that
 * agents provably follow and cite. An agent's context assembly loads the active
 * revision of every procedure assigned to it; run events record citations.
 */
export const procedureStatus = pgEnum('procedure_status', ['draft', 'active', 'retired'])

export type ProcedureAssignment = {
  /** Role-pack slugs this procedure binds to (every agent hired from the pack). */
  rolePacks?: string[]
  /** Specific people (agents) it binds to. */
  personIds?: string[]
  /** True = binds to every agent in the company. */
  everyone?: boolean
}

export type ProcedureSource =
  | { type: 'authored' }
  | { type: 'upload'; fileId: string }
  | { type: 'role-pack'; pack: string; procedure: string }

/** One numbered step of a procedure. Detail is markdown. */
export type ProcedureStep = {
  id: string
  title: string
  detail: string
  /** Stop here and get a human's decision before carrying on. */
  checkWithHuman: boolean
}

/**
 * The authored structure of a revision. Rendered to `body` on every write —
 * `body` is what an agent reads, this is what an operator edits.
 */
export type ProcedureContent = {
  /** The trigger: when this procedure applies. */
  whenToUse: string
  steps: ProcedureStep[]
  /** What must be true before the work counts as done. */
  successCriteria: string[]
  /** When to stop and agent the work to a person instead. */
  escalation: string
}

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
    /**
     * Markdown, rendered from `content` — the text an agent reads. The revision a
     * agent followed is pinned by (procedureId, version), so this is never edited
     * in place; a change is a new row.
     */
    body: text('body').notNull(),
    /**
     * The authored structure this body was rendered from. Null on revisions
     * written before procedures had steps, and on role-pack-shipped prose.
     */
    content: jsonb('content').$type<ProcedureContent>(),
    changeNote: text('change_note'),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('procedure_revisions_version_key').on(t.procedureId, t.version),
    index('procedure_revisions_tenant_idx').on(t.tenantId, t.procedureId),
  ],
)

export const PROCEDURES_TENANT_TABLES = ['procedures', 'procedure_revisions'] as const
