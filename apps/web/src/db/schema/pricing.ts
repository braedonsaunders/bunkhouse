import { index, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { auditColumns, id, money, tenantRef } from '@appkit/db'

/**
 * Effective-dated model pricing — the source of truth for what a token costs
 * THIS company. Rows are append-only: a price change is a new row with a later
 * effectiveAt, never an edit, so historical spend is never reinterpreted.
 * Resolution: exact model id at spend time, else the '*' wildcard row.
 */
export const priceSource = pgEnum('price_source', ['openrouter', 'manual'])

export const modelPrices = pgTable(
  'model_prices',
  {
    id: id(),
    tenantId: tenantRef(),
    /** Model id as the provider reports it (e.g. claude-sonnet-5), or '*'. */
    model: text('model').notNull(),
    inputUsdPerMtok: money('input_usd_per_mtok').notNull(),
    outputUsdPerMtok: money('output_usd_per_mtok').notNull(),
    source: priceSource('source').notNull(),
    /** Where the number came from, for audit (e.g. the OpenRouter model id). */
    sourceRef: text('source_ref'),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [index('model_prices_lookup_idx').on(t.tenantId, t.model, t.effectiveAt)],
)

export const PRICING_TENANT_TABLES = ['model_prices'] as const
