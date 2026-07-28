import { boolean, index, integer, jsonb, pgEnum, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@appkit/db'

/**
 * The Logbook (docs/memory-design.md): human-readable markdown notes are the
 * single source of truth. Notes are typed (fact/episode/procedure/reflection),
 * linked with [[wikilinks]] (memory_links is a parse cache), and bi-temporal:
 * a contradiction closes the old note's validity window and points at its
 * successor — never an edit into falsehood, never a delete. Corrections
 * snapshot the prior head into revisions. The tsvector column and GIN index
 * live in SQL (migration 0008); they are derived, rebuildable, never
 * authoritative.
 */
export const memoryScope = pgEnum('memory_scope', ['agent', 'company'])
export const memoryStatus = pgEnum('memory_status', ['active', 'archived'])
export const memoryKind = pgEnum('memory_kind', ['fact', 'episode', 'procedure', 'reflection'])
export const memoryAuthor = pgEnum('memory_author', ['agent', 'human', 'consolidator'])

export const memories = pgTable(
  'memories',
  {
    id: id(),
    tenantId: tenantRef(),
    scope: memoryScope('scope').notNull(),
    /** Owning agent; null for company scope. */
    personId: uuid('person_id'),
    slug: text('slug').notNull(),
    kind: memoryKind('kind').notNull().default('fact'),
    title: text('title').notNull(),
    /** Markdown; may contain [[slug]] wikilinks to other notes. */
    body: text('body').notNull(),
    status: memoryStatus('status').notNull().default('active'),
    /** Pinned notes are always in the agent's prompt, under a hard budget. */
    pinned: boolean('pinned').notNull().default(false),
    /** 1–5, assigned at write time (LLM or human), always human-editable. */
    importance: smallint('importance').notNull().default(3),
    /** Bi-temporal validity: when the fact was true in the world. */
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    /** Null = still believed. Set on supersession/expiry; row is never deleted. */
    validUntil: timestamp('valid_until', { withTimezone: true }),
    supersededBy: uuid('superseded_by'),
    author: memoryAuthor('author').notNull().default('human'),
    /** Run that wrote or last revised this memory, when an agent authored it. */
    sourceRunId: uuid('source_run_id'),
    /** Usage telemetry, rolled up from memory.retrieved run events. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    useCount: integer('use_count').notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('memories_scope_slug_key').on(t.tenantId, t.scope, t.personId, t.slug),
    index('memories_person_idx').on(t.tenantId, t.personId, t.status),
    index('memories_live_idx').on(t.tenantId, t.validUntil, t.pinned),
  ],
)

/** Append-only history: every in-place correction snapshots the prior head. */
export const memoryRevisions = pgTable(
  'memory_revisions',
  {
    id: id(),
    tenantId: tenantRef(),
    noteId: uuid('note_id').notNull(),
    rev: integer('rev').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** 'agent' | 'human' | 'consolidator' + optional detail. */
    editedBy: text('edited_by').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('memory_revisions_rev_key').on(t.noteId, t.rev)],
)

/** Parse cache of [[wikilinks]] — rebuildable by re-parsing every body. */
export const memoryLinks = pgTable(
  'memory_links',
  {
    tenantId: tenantRef(),
    fromNote: uuid('from_note').notNull(),
    toNote: uuid('to_note').notNull(),
  },
  (t) => [
    uniqueIndex('memory_links_pk').on(t.fromNote, t.toNote),
    index('memory_links_to_idx').on(t.tenantId, t.toNote),
  ],
)

/** The approval gate: promotion and consolidator rewrites are proposals. */
export const memoryProposalKind = pgEnum('memory_proposal_kind', ['promote', 'merge', 'supersede', 'expire', 'edit'])
export const memoryProposalStatus = pgEnum('memory_proposal_status', ['open', 'approved', 'rejected', 'auto_applied'])

export type MemoryProposalPayload = {
  title?: string
  body?: string
  /** Notes consumed by a merge/supersede, for the diff view. */
  noteIds?: string[]
}

export const memoryProposals = pgTable(
  'memory_proposals',
  {
    id: id(),
    tenantId: tenantRef(),
    kind: memoryProposalKind('kind').notNull(),
    /** Subject note (the agent note being promoted, the target of an edit…). */
    noteId: uuid('note_id'),
    payload: jsonb('payload').$type<MemoryProposalPayload>().notNull(),
    rationale: text('rationale').notNull(),
    /** Agent that proposed it; null when the consolidator job did. */
    proposedByPersonId: uuid('proposed_by_person_id'),
    status: memoryProposalStatus('status').notNull().default('open'),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [index('memory_proposals_open_idx').on(t.tenantId, t.status)],
)

export const MEMORY_TENANT_TABLES = ['memories', 'memory_revisions', 'memory_links', 'memory_proposals'] as const
