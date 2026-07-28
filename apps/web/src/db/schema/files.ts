import { bigint, index, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@appkit/db'

/**
 * The files ledger — every artifact an agent produces or receives is a row here,
 * with the bytes in object storage (@appkit/storage) under `storageKey`.
 *
 * Append-only: files are immutable once written; a revised deliverable is a new
 * row. Deleting a file record is an operator action that also removes the object.
 */
export const fileKind = pgEnum('file_kind', [
  /** Generated .docx / .pdf work product. */
  'document',
  /** Generated .xlsx work product. */
  'spreadsheet',
  /** Inbound or outbound mail attachment. */
  'attachment',
  /** Call or session recording. */
  'recording',
  /** Operator-uploaded material (branding assets, knowledge sources). */
  'upload',
])

export const files = pgTable(
  'files',
  {
    id: id(),
    tenantId: tenantRef(),
    /** The agent (or human) the file belongs to; drives profile surfacing. */
    personId: uuid('person_id'),
    /** The run that produced or received it (audit anchor), when there is one. */
    runId: uuid('run_id'),
    kind: fileKind('kind').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    /** Tenant-scoped object key in the storage bucket. */
    storageKey: text('storage_key').notNull(),
    /** Integrity fingerprint of the stored bytes. */
    sha256: text('sha256').notNull(),
    ...auditColumns,
  },
  (t) => [
    index('files_person_idx').on(t.tenantId, t.personId, t.createdAt),
    index('files_run_idx').on(t.tenantId, t.runId),
  ],
)

export const FILES_TENANT_TABLES = ['files'] as const
