import { date, index, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { auditColumns, id, money, tenantRef } from '@braedonsaunders/appkit-db'

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

/**
 * What the provider says the company was charged, next to what the ledger
 * estimated for the same day and model.
 *
 * Anthropic and OpenAI report cost in daily buckets for the whole organization
 * — real money, but arriving a day late and attributable to no particular run.
 * That makes it useless as a per-agent charge and invaluable as a check: it
 * says whether the price table is right, and by how much it is wrong. So the
 * per-person ledger is left alone and the truth is banked here beside it.
 *
 * Rows are append-only, effective by `fetchedAt`, exactly like model_prices: a
 * provider finalizing its books days later is a new row, never an edit to the
 * one an operator has already read. A day whose figures have not moved appends
 * nothing at all.
 */
export const costReconciliations = pgTable(
  'cost_reconciliations',
  {
    id: id(),
    tenantId: tenantRef(),
    /** The provider kind the report came from: 'anthropic' | 'openai'. */
    provider: text('provider').notNull(),
    /** The UTC day the bucket covers. */
    day: date('day').notNull(),
    /** Model as the provider named it, or '*' where it named no model. */
    model: text('model').notNull(),
    /** USD the provider says it charged for that day and model. */
    reportedUsd: money('reported_usd').notNull(),
    /** USD the spend ledger holds for the same day and provider kind. */
    ledgerUsd: money('ledger_usd').notNull(),
    /** reported − ledger. Positive means the company under-counted its spend. */
    driftUsd: money('drift_usd').notNull(),
    /** Which account answered, for audit (workspace id, project id, …). */
    sourceRef: text('source_ref'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [index('cost_reconciliations_lookup_idx').on(t.tenantId, t.provider, t.day, t.fetchedAt)],
)

export const PRICING_TENANT_TABLES = ['model_prices', 'cost_reconciliations'] as const
