import { jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@appkit/db'
import type { SealedSecret } from '@appkit/crypto'
import type { RawSmsConfig } from '@appkit/sms'
import type { RawCarrierConfig } from '@appkit/telephony'

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
  /** Present when the connection signed in with OAuth instead of headers. */
  oauth?: McpOauthGrant
  /** Action category the autonomy dial governs this integration under. */
  category: string
}

/** An OAuth connection's standing credential: everything needed to mint a
 *  fresh access token without the operator — endpoints from discovery, the
 *  (usually dynamically registered) client, and the sealed token set. */
export type McpOauthGrant = {
  tokenEndpoint: string
  /** RFC 8707 resource indicator the tokens are bound to. */
  resource: string
  clientId: string
  /** Only for pre-registered confidential clients; DCR clients are public. */
  sealedClientSecret?: SealedSecret
  /** Sealed JSON of { accessToken, refreshToken?, expiresAt? }. */
  sealedTokens: SealedSecret
}

export const MCP_INTEGRATIONS_KEY = 'integrations.mcp'

/** settings key: 'integrations.mcp.pending' — OAuth sign-ins in flight. Each
 *  entry holds one authorization round-trip's context between the redirect
 *  out and the callback in; the browser carries only a sealed reference to
 *  it. Entries expire after ten minutes and are dropped on completion. */
export type McpOauthPending = {
  /** Random handle the sealed state parameter names. */
  nonce: string
  /** The integration being connected, exactly as the drawer collected it. */
  slug: string
  label: string
  url: string
  category: string
  /** Discovery + registration results the callback finishes with. */
  tokenEndpoint: string
  resource: string
  clientId: string
  sealedClientSecret?: SealedSecret
  /** Sealed PKCE code verifier. */
  sealedVerifier: SealedSecret
  createdAt: number
}

export const MCP_OAUTH_PENDING_KEY = 'integrations.mcp.pending'

/**
 * settings key: 'company.identity' — who the company is, in the company's own
 * words. Every agent works here, so this is the ground an agent stands on:
 * what the business does, who it serves, how it sounds, and how to reach it.
 * The runtime folds it into every system prompt; nothing here is a secret, and
 * an operator can write all of it by hand or draft it from the website.
 */
export type CompanyIdentitySettings = {
  /** Trading name — what agents call the company in conversation. */
  name?: string
  /** Registered/legal entity name, when it differs from the trading name. */
  legalName?: string
  tagline?: string
  websiteUrl?: string
  industry?: string
  /** Markdown. What the business does, in prose. */
  description?: string
  services?: string[]
  /** Where the company works — "Southwestern Ontario", "nationwide", … */
  serviceArea?: string
  /** Who it serves: segments, industries, customer types. */
  customers?: string[]
  /** What sets it apart — the claims an agent may repeat truthfully. */
  differentiators?: string[]
  values?: string[]
  /** How the company sounds; steers every agent's tone alongside its own. */
  brandVoice?: string
  /** Business hours in plain language. */
  hours?: string
  contact?: {
    phone?: string
    email?: string
    address?: string
  }
  /** Public profiles, keyed by network (linkedin, facebook, …). */
  socialLinks?: Record<string, string>
  /** Markdown. Anything else every agent should know about the company. */
  notes?: string
  /**
   * Provenance of the last website draft. Present only when a capture ran;
   * an operator's edits since then are not tracked here — the settings row's
   * own audit columns carry who changed it and when.
   */
  capture?: {
    websiteUrl: string
    /** ISO timestamp of the capture that produced the draft. */
    capturedAt: string
    /** Provider slug + model that read the site, for the record. */
    provider: string
    model: string
    pagesRead: number
  }
}

export const COMPANY_IDENTITY_KEY = 'company.identity'

/** settings key: 'documents.branding' — how agent-authored documents present
 *  the company: the letterhead line, accent color, and footer on every
 *  generated .docx and .pdf. The letterhead name is an OVERRIDE — left empty,
 *  documents use the company name from `company.identity`, which stays the
 *  single source of truth for what the company is called. */
export type DocumentBrandingSettings = {
  companyName?: string
  /** Hex accent for headings/rules, e.g. #1a4d8f. */
  accentColor?: string
  footerText?: string
}

export const DOCUMENT_BRANDING_KEY = 'documents.branding'

/** settings key: 'mail.signature' — the company-wide signature appended to
 *  every message an agent sends. Designed once in Settings → Mail → Signature
 *  and personalized per sender at send time through `{{agent.*}}` tokens, so
 *  one design serves the whole roster. Two halves are kept, exactly as
 *  @appkit/email-designer produces them: `sourceHtml` reopens in the designer,
 *  `compiledHtml` is what renders. Off by default — until an operator turns it
 *  on, agents sign off in their own words and nothing is appended. */
export type MailSignatureSettings = {
  enabled: boolean
  /** Reopenable designer source: sanitized, `<style>` and markers intact. */
  sourceHtml: string
  /** Delivery-ready: CSS inlined, markers expanded, `{{tokens}}` embedded. */
  compiledHtml: string
  /** Hex accent the designer seeds new blocks with, e.g. #F5A623. */
  accentColor?: string
}

export const MAIL_SIGNATURE_KEY = 'mail.signature'

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

/** settings key: 'voice.carrier' — the company's telephony carrier account,
 *  used to buy phone numbers and to build the SIP trunk that carries them, per
 *  @appkit/telephony's RawCarrierConfig shape. Only the account's identity and
 *  its sealed secret live here; the trunk the account provisions is a
 *  sip_trunks row like any other, and the numbers are phone_numbers rows. The
 *  secret is sealed at rest using that package's own ciphertext/nonce fields,
 *  and is unsealed only for a request to the carrier. */
export type CarrierSettings = RawCarrierConfig

export const CARRIER_KEY = 'voice.carrier'

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

/** Where agent-produced files are copied to, on top of the files ledger. */
export type FilingProvider = 'google_drive' | 'onedrive' | 'smb'

/** Which ledger kinds are copied out to company storage. */
export type FilingFileKind = 'document' | 'spreadsheet' | 'attachment'

/** Subfolder layout inside the destination folder. */
export type FilingLayout = 'flat' | 'agent' | 'month'

/**
 * The connected destination. Google and Microsoft carry the refresh token
 * granted by the company's own application, sealed at rest exactly like a
 * mailbox credential; a server folder carries no secret at all.
 */
export type FilingTarget =
  | {
      provider: 'google_drive'
      /** How the destination reads in Settings, e.g. "Drive · Bunkhouse deliverables". */
      label: string
      /** The account that granted access. */
      account: string
      /** The app-created folder everything is filed into. */
      folderId: string
      folderName: string
      sealedRefreshToken: SealedSecret
    }
  | {
      provider: 'onedrive'
      label: string
      account: string
      /** A SharePoint document-library drive id, or null for the user's OneDrive. */
      driveId: string | null
      /** Destination folder path relative to the drive root. */
      folderPath: string
      sealedRefreshToken: SealedSecret
    }
  | {
      provider: 'smb'
      label: string
      /** Absolute path to the mounted share, as the server sees it. */
      basePath: string
    }

/** settings key: 'storage.filing' — optional filing of agent-produced files
 *  into the company's real storage. The files ledger is always the system of
 *  record; filing is an additional copy, best-effort by design, so a connector
 *  outage never holds a deliverable back. Application client secrets and
 *  granted refresh tokens are sealed at rest and unsealed only for a request. */
export type FilingSettings = {
  /** Master switch. Off = nothing is copied anywhere. */
  enabled: boolean
  target: FilingTarget | null
  kinds: FilingFileKind[]
  layout: FilingLayout
  /** The company's own OAuth applications, one per provider. */
  apps: {
    google?: { clientId: string; sealedClientSecret: SealedSecret }
    microsoft?: {
      clientId: string
      sealedClientSecret: SealedSecret
      /** Microsoft Entra directory: a directory (tenant) ID, or 'common'. */
      tenant: string
    }
  }
}

export const FILING_SETTINGS_KEY = 'storage.filing'

/**
 * settings key: 'integrations.chat' — the tenant's Slack and Microsoft Teams
 * connections. Chat is a secondary surface (doctrine #1): it reaches the same
 * runs/run_events ledger mail does, this key only holds the credentials.
 *
 * Slack carries a bot token and signing secret, both sealed; `teamId`/
 * `teamName` are plain (Slack's workspace identity, not a secret — captured
 * from `auth.test` at connect time, shown in Settings). Teams ships outbound
 * via an Incoming Webhook URL (sealed — it is itself a bearer credential);
 * inbound is optional and, in this build, wired through Teams' lightweight
 * Outgoing Webhook mechanism (a per-channel HMAC security token) rather than
 * a full Azure Bot Service registration — see lib/chat-bridge.ts for why.
 */
export type ChatIntegrationSettings = {
  slack?: {
    teamId: string
    teamName: string
    sealedBotToken: SealedSecret
    sealedSigningSecret: SealedSecret
  }
  teams?: {
    /** Outbound: an Incoming Webhook connector URL. */
    sealedWebhookUrl?: SealedSecret
    /** Inbound (optional): the Outgoing Webhook's HMAC security token, base64. */
    sealedSecurityToken?: SealedSecret
    /** Informational, shown back in Settings — not used to authorize anything. */
    msTenantId?: string
    appId?: string
  }
}

export const CHAT_INTEGRATIONS_KEY = 'integrations.chat'

export const SETTINGS_TENANT_TABLES = ['tenant_settings'] as const
