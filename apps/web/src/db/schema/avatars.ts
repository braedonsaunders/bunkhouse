import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@appkit/db'

/**
 * Chosen avatar per person, stored inline (TOASTed base64) until the shared
 * storage connector slice; served via /api/avatars/[personId].
 */
export const avatarImages = pgTable(
  'avatar_images',
  {
    id: id(),
    tenantId: tenantRef(),
    personId: uuid('person_id').notNull(),
    contentType: text('content_type').notNull(),
    /** base64 payload (no data: prefix). */
    data: text('data').notNull(),
    /** Which model produced it, for provenance. */
    model: text('model').notNull(),
    ...auditColumns,
  },
  (t) => [uniqueIndex('avatar_images_person_ux').on(t.tenantId, t.personId)],
)

export const AVATARS_TENANT_TABLES = ['avatar_images'] as const
