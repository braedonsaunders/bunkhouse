import { pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@appkit/db'

/** A person has two likenesses: the portrait (lists, headers, calls) and the
 *  standing full-body character used in scenes like the lobby. */
export const avatarKind = pgEnum('avatar_kind', ['portrait', 'full_body'])

/**
 * Chosen avatars per person, stored inline (TOASTed base64) until the shared
 * storage connector slice; served via /api/avatars/[personId]?kind=.
 */
export const avatarImages = pgTable(
  'avatar_images',
  {
    id: id(),
    tenantId: tenantRef(),
    personId: uuid('person_id').notNull(),
    kind: avatarKind('kind').notNull().default('portrait'),
    contentType: text('content_type').notNull(),
    /** base64 payload (no data: prefix). */
    data: text('data').notNull(),
    /** Which model produced it, for provenance. */
    model: text('model').notNull(),
    ...auditColumns,
  },
  (t) => [uniqueIndex('avatar_images_person_kind_ux').on(t.tenantId, t.personId, t.kind)],
)

export const AVATARS_TENANT_TABLES = ['avatar_images'] as const
