import { index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@braedonsaunders/appkit-db'
import type { AvatarComposition } from '@braedonsaunders/appkit-avatars/composition'

/**
 * The tenant's parts library — the raw material every figure is built from.
 *
 * Parts are shared assets, not per-person art: one good "safety vest" is worn
 * by everyone on the crew. Stored inline (TOASTed base64) alongside the rest of
 * the generated art until the shared storage connector slice; served through
 * /api/avatar-parts/[partId].
 *
 * `categoryId` keys into the code-constant categories in `lib/avatar-parts.ts`,
 * which own the layer order and default placement.
 */
export const avatarParts = pgTable(
  'avatar_parts',
  {
    id: id(),
    tenantId: tenantRef(),
    categoryId: text('category_id').notNull(),
    name: text('name').notNull(),
    contentType: text('content_type').notNull(),
    /** base64 payload (no data: prefix). */
    data: text('data').notNull(),
    /**
     * When set, this row is a recoloured take of the same shape and appears as
     * a colour option on the base part rather than as its own library entry.
     */
    colorVariant: text('color_variant'),
    tags: text('tags').array().notNull().default([]),
    /** Which model produced it, for provenance. */
    model: text('model').notNull(),
    /** The prompt it came from, so a set can be extended consistently. */
    prompt: text('prompt'),
    ...auditColumns,
  },
  (t) => [index('avatar_parts_category_ix').on(t.tenantId, t.categoryId)],
)

/**
 * One avatar per person: a full-body composition over the parts library.
 *
 * There is no portrait row and no rendered-image cache. A portrait is this
 * composition cropped to its head viewport, resolved in the browser — which is
 * what lets a mouth move on a live call and keeps one figure sharp from a 24px
 * directory row to a full stage.
 */
export const avatarCompositions = pgTable(
  'avatar_compositions',
  {
    id: id(),
    tenantId: tenantRef(),
    personId: uuid('person_id').notNull(),
    composition: jsonb('composition').$type<AvatarComposition>().notNull(),
    ...auditColumns,
  },
  (t) => [uniqueIndex('avatar_compositions_person_ux').on(t.tenantId, t.personId)],
)

export const AVATARS_TENANT_TABLES = ['avatar_parts', 'avatar_compositions'] as const
