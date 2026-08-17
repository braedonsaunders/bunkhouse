import { index, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@braedonsaunders/appkit-db'

/**
 * The filing log — every attempt to copy a ledgered file out to the company's
 * own storage (Google Drive, OneDrive/SharePoint, or a mounted server folder).
 *
 * Append-only, and deliberately records failures as loudly as successes:
 * filing is best-effort by design (a deliverable is never held back because a
 * connector was down), so this table is the only place an operator can see
 * that a copy did not land, and why.
 */
export const filingProvider = pgEnum('filing_provider', ['google_drive', 'onedrive', 'smb'])

export const filingStatus = pgEnum('filing_status', ['filed', 'failed'])

export const fileFilings = pgTable(
  'file_filings',
  {
    id: id(),
    tenantId: tenantRef(),
    /** The `files` row that was copied out. */
    fileId: uuid('file_id').notNull(),
    provider: filingProvider('provider').notNull(),
    status: filingStatus('status').notNull(),
    /** Where the copy landed: a provider URL or an absolute server path. */
    location: text('location'),
    /** Why it did not land, in the provider's own words. */
    reason: text('reason'),
    ...auditColumns,
  },
  (t) => [
    index('file_filings_recent_idx').on(t.tenantId, t.createdAt),
    index('file_filings_file_idx').on(t.tenantId, t.fileId),
  ],
)

export const FILING_TENANT_TABLES = ['file_filings'] as const
