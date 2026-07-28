import { jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@appkit/db'
import type { SealedSecret } from '@appkit/crypto'

/**
 * Per-tenant configuration, one row per key — the single source of truth for
 * everything an operator configures in-app. Never mirrored into env.
 */
export const tenantSettings = pgTable(
  'tenant_settings',
  {
    id: id(),
    tenantId: tenantRef(),
    key: text('key').notNull(),
    value: jsonb('value').$type<unknown>().notNull(),
    ...auditColumns,
  },
  (t) => [uniqueIndex('tenant_settings_key_ux').on(t.tenantId, t.key)],
)

/** settings key: 'ai.providers' — the tenant's model providers, keys sealed. */
export type AiProviderEntry = {
  /** Stable slug hands reference from their modelConfig.provider. */
  slug: string
  /** @appkit/ai provider kind: anthropic | openai | google | openrouter | … */
  provider: string
  label: string
  sealedApiKey: SealedSecret
  baseUrl?: string
  /** Default models offered when assigning a hand. */
  modelSmart?: string
  modelFast?: string
}

export const AI_PROVIDERS_KEY = 'ai.providers'

export const SETTINGS_TENANT_TABLES = ['tenant_settings'] as const
