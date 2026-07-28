import { jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@appkit/db'
import type { SealedSecret } from '@appkit/crypto'
import type { RawSmsConfig } from '@appkit/sms'

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
  /** Stable slug agents reference from their modelConfig.provider. */
  slug: string
  /** @appkit/ai provider kind: anthropic | openai | google | openrouter | … */
  provider: string
  label: string
  sealedApiKey: SealedSecret
  baseUrl?: string
  /** Default models offered when assigning an agent. */
  modelSmart?: string
  modelFast?: string
}

export const AI_PROVIDERS_KEY = 'ai.providers'

/** settings key: 'voice.providers' — the tenant's speech-provider keys
 *  (STT/TTS for cascade voice), sealed at rest like AI provider keys.
 *  Realtime speech-to-speech reuses the AI providers above — no second key. */
export type VoiceProviderSettings = {
  deepgram?: { sealedApiKey: SealedSecret }
  elevenlabs?: { sealedApiKey: SealedSecret }
}

export const VOICE_PROVIDERS_KEY = 'voice.providers'

/** settings key: 'integrations.mcp' — external systems agents can use, over
 *  MCP. Every tool a server exposes is governed under the one action category
 *  chosen here; auth headers are sealed at rest like every other credential. */
export type McpIntegrationEntry = {
  /** Stable slug; tool names are namespaced under it (`slug_toolName`). */
  slug: string
  label: string
  url: string
  /** Sealed JSON object of request headers (e.g. an Authorization token). */
  sealedHeaders?: SealedSecret
  /** Action category the autonomy dial governs this integration under. */
  category: string
}

export const MCP_INTEGRATIONS_KEY = 'integrations.mcp'

/** settings key: 'documents.branding' — how agent-authored documents present
 *  the company: the letterhead line, accent color, and footer on every
 *  generated .docx and .pdf. */
export type DocumentBrandingSettings = {
  companyName?: string
  /** Hex accent for headings/rules, e.g. #1a4d8f. */
  accentColor?: string
  footerText?: string
}

export const DOCUMENT_BRANDING_KEY = 'documents.branding'

/** settings key: 'workspace.policy' — housekeeping for agents' persistent
 *  workspaces. `retentionDays: null` means keep everything (the default —
 *  nothing is ever deleted unless an operator turns retention on). */
export type WorkspacePolicySettings = {
  retentionDays: number | null
}

export const WORKSPACE_POLICY_KEY = 'workspace.policy'

/** settings key: 'sms.provider' — the tenant's SMS provider config, per
 *  @appkit/sms's RawSmsConfig shape. The single credential (auth token / API
 *  secret / access key, depending on provider) is sealed at rest using that
 *  package's own ciphertext/nonce fields, and is only unsealed at send time. */
export type SmsProviderSettings = RawSmsConfig

export const SMS_PROVIDER_KEY = 'sms.provider'

/** settings key: 'mail.oauthApps' — the company's own Google Workspace and
 *  Microsoft 365 applications, used to sign agents into their mailboxes. Only
 *  the application's identity lives here; the per-mailbox refresh token is
 *  sealed on the mailbox account row, not in settings. Client secrets are
 *  sealed at rest and unsealed only during a token exchange. */
export type MailOauthAppSettings = {
  google?: { clientId: string; sealedClientSecret: SealedSecret }
  microsoft?: {
    clientId: string
    sealedClientSecret: SealedSecret
    /** Microsoft Entra directory: a directory (tenant) ID, or 'common'. */
    tenant: string
  }
}

export const MAIL_OAUTH_APPS_KEY = 'mail.oauthApps'

export const SETTINGS_TENANT_TABLES = ['tenant_settings'] as const
