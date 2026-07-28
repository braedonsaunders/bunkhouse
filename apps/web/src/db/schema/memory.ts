import { index, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@appkit/db'

/**
 * Memory is human-readable by doctrine: one row = one fact/note in markdown,
 * openable and editable from the hand's HR profile. Hand-scoped memory belongs
 * to one hand; company-scoped memory is the governed shared knowledge layer
 * every hand loads. Promotion from hand → company is an edit, not magic.
 */
export const memoryScope = pgEnum('memory_scope', ['hand', 'company'])
export const memoryStatus = pgEnum('memory_status', ['active', 'archived'])

export const memories = pgTable(
  'memories',
  {
    id: id(),
    tenantId: tenantRef(),
    scope: memoryScope('scope').notNull(),
    /** Owning hand; null for company scope. */
    personId: uuid('person_id'),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    /** Markdown; short, single-fact notes — the profile renders these verbatim. */
    body: text('body').notNull(),
    status: memoryStatus('status').notNull().default('active'),
    /** Run that wrote or last revised this memory, when a hand authored it. */
    sourceRunId: uuid('source_run_id'),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('memories_scope_slug_key').on(t.tenantId, t.scope, t.personId, t.slug),
    index('memories_person_idx').on(t.tenantId, t.personId, t.status),
  ],
)

export const MEMORY_TENANT_TABLES = ['memories'] as const
