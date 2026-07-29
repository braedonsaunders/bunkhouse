import 'server-only'
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { sealSecret, unsealSecret, type SealedSecret } from '@appkit/crypto'
import {
  buildAuthorizationUrl,
  createPkce,
  discoverAuthorization,
  exchangeAuthorizationCode,
  refreshTokens,
  registerClient,
  type OAuthTokens,
} from '@appkit/oauth'
import { connectMcpServers } from '@bunkhouse/runtime'
import {
  tenantSettings,
  MCP_OAUTH_PENDING_KEY,
  type McpIntegrationEntry,
  type McpOauthGrant,
  type McpOauthPending,
} from '../db/schema'
import { db } from '../db/client'
import { listMcpIntegrations, saveMcpIntegrations } from './mcp-integrations'

/**
 * Signing an MCP connection in with OAuth, for the servers that refuse plain
 * token headers (HubSpot, Asana, Canva, most of the newer hosted ones).
 *
 * The shape mirrors the mailbox sign-in: the browser carries only a sealed
 * state reference; everything the callback needs — the discovered endpoints,
 * the (usually dynamically registered) client, the PKCE verifier, and the
 * drawer's own fields — waits in tenant settings for at most ten minutes.
 * Once tokens arrive they are sealed onto the integration entry, and every
 * later connection mints a fresh access token from the refresh token, exactly
 * like a mailbox does before an IMAP dial.
 */

/** How long an in-flight authorization may take before its state is refused. */
const STATE_MAX_AGE_MS = 10 * 60 * 1000

/** Refresh when the access token has less life left than a slow MCP dial. */
const EXPIRY_SLACK_MS = 60 * 1000

export function mcpOauthRedirectUri(): string {
  const base = process.env.APP_URL ?? 'http://localhost:4810'
  return `${base.replace(/\/+$/, '')}/api/mcp-oauth/callback`
}

// --- Pending authorizations ---------------------------------------------------

async function readPending(tenantId: string): Promise<McpOauthPending[]> {
  const app = db()
  const [row] = await app.db
    .select({ value: tenantSettings.value })
    .from(tenantSettings)
    .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, MCP_OAUTH_PENDING_KEY)))
  const entries = (row?.value as McpOauthPending[] | undefined) ?? []
  return entries.filter((entry) => Date.now() - entry.createdAt <= STATE_MAX_AGE_MS)
}

async function writePending(tenantId: string, entries: McpOauthPending[]): Promise<void> {
  const app = db()
  await app.db
    .insert(tenantSettings)
    .values({ tenantId, key: MCP_OAUTH_PENDING_KEY, value: entries })
    .onConflictDoUpdate({
      target: [tenantSettings.tenantId, tenantSettings.key],
      set: { value: entries, updatedAt: new Date() },
    })
}

// --- Browser state ------------------------------------------------------------

type McpOauthState = { tenantId: string; nonce: string; ts: number }

function sealState(state: McpOauthState): string {
  return Buffer.from(JSON.stringify(sealSecret(JSON.stringify(state))), 'utf8').toString('base64url')
}

function openState(encoded: string): McpOauthState {
  let sealed: SealedSecret
  try {
    sealed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SealedSecret
  } catch {
    throw new Error('That sign-in link is not valid. Start the connection again from Settings → Integrations.')
  }
  const plain = unsealSecret(sealed)
  if (plain === null) {
    throw new Error('That sign-in could not be verified. Start the connection again from Settings → Integrations.')
  }
  const state = JSON.parse(plain) as McpOauthState
  if (typeof state.tenantId !== 'string' || typeof state.nonce !== 'string' || typeof state.ts !== 'number') {
    throw new Error('That sign-in could not be verified. Start the connection again from Settings → Integrations.')
  }
  if (Date.now() - state.ts > STATE_MAX_AGE_MS) {
    throw new Error('That sign-in took too long to finish. Start the connection again from Settings → Integrations.')
  }
  return state
}

// --- Begin -------------------------------------------------------------------

/**
 * Discover how the server signs in, register (or accept) a client, park the
 * round-trip context, and hand back the consent URL for the browser. Throws
 * readable messages — the drawer shows them verbatim.
 */
export async function beginMcpOauth(input: {
  tenantId: string
  slug: string
  label: string
  url: string
  category: string
  /** Pre-registered application credentials, for servers without DCR. */
  clientId?: string
  clientSecret?: string
}): Promise<{ url: string }> {
  const redirectUri = mcpOauthRedirectUri()
  const authorization = await discoverAuthorization(input.url)
  const client = input.clientId
    ? { clientId: input.clientId, ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}) }
    : await registerClient({ authorization, redirectUri, clientName: 'Bunkhouse' })

  const pkce = createPkce()
  const nonce = randomBytes(16).toString('base64url')
  const pending: McpOauthPending = {
    nonce,
    slug: input.slug,
    label: input.label,
    url: input.url,
    category: input.category,
    tokenEndpoint: authorization.tokenEndpoint,
    resource: authorization.resource,
    clientId: client.clientId,
    ...(client.clientSecret ? { sealedClientSecret: sealSecret(client.clientSecret) } : {}),
    sealedVerifier: sealSecret(pkce.verifier),
    createdAt: Date.now(),
  }

  const app = db()
  await app.withTenant(input.tenantId, async () => {
    const entries = (await readPending(input.tenantId)).filter((entry) => entry.slug !== input.slug)
    entries.push(pending)
    await writePending(input.tenantId, entries)
  })

  return {
    url: buildAuthorizationUrl({
      authorization,
      clientId: client.clientId,
      redirectUri,
      codeChallenge: pkce.challenge,
      state: sealState({ tenantId: input.tenantId, nonce, ts: Date.now() }),
      ...(authorization.scopesSupported?.length ? { scope: authorization.scopesSupported.join(' ') } : {}),
    }),
  }
}

// --- Complete ------------------------------------------------------------------

export type CompleteMcpOauthResult =
  | { ok: true; label: string; toolCount: number }
  | { ok: false; message: string }

/**
 * Finish the round-trip: validate the state, exchange the code, prove the
 * token actually opens the MCP server, and save the connection. Returns a
 * result rather than throwing so the callback route can send the operator
 * back to Settings with a readable explanation instead of an error page.
 */
export async function completeMcpOauth(input: { state: string; code: string }): Promise<CompleteMcpOauthResult> {
  let state: McpOauthState
  try {
    state = openState(input.state)
  } catch (error) {
    return { ok: false, message: messageOf(error) }
  }
  try {
    const app = db()
    // Claim the pending round-trip and commit that consumption before any
    // network work: one code, one exchange, and no database transaction is
    // held open across the provider round-trips that follow.
    const pending = await app.withTenant(state.tenantId, async () => {
      const entries = await readPending(state.tenantId)
      const claimed = entries.find((entry) => entry.nonce === state.nonce) ?? null
      if (claimed) await writePending(state.tenantId, entries.filter((entry) => entry.nonce !== state.nonce))
      return claimed
    })
    if (!pending) {
      return {
        ok: false,
        message: 'That sign-in was already completed or expired. Start the connection again from Settings → Integrations.',
      }
    }
    const verifier = unsealSecret(pending.sealedVerifier)
    if (verifier === null) {
      return { ok: false, message: 'The sign-in context could not be unsealed. Start the connection again.' }
    }
    const clientSecret = pending.sealedClientSecret ? unsealSecret(pending.sealedClientSecret) : null

    const tokens = await exchangeAuthorizationCode({
      authorization: { tokenEndpoint: pending.tokenEndpoint, resource: pending.resource },
      client: { clientId: pending.clientId, ...(clientSecret ? { clientSecret } : {}) },
      code: input.code,
      codeVerifier: verifier,
      redirectUri: mcpOauthRedirectUri(),
    })

    // Prove the grant opens the server before anything is stored.
    const probe = await connectMcpServers([
      { slug: pending.slug, url: pending.url, headers: { Authorization: `${tokens.tokenType} ${tokens.accessToken}` } },
    ])
    const toolCount = probe.abilities.length
    await probe.close()

    const grant: McpOauthGrant = {
      tokenEndpoint: pending.tokenEndpoint,
      resource: pending.resource,
      clientId: pending.clientId,
      ...(pending.sealedClientSecret ? { sealedClientSecret: pending.sealedClientSecret } : {}),
      sealedTokens: sealTokens(tokens),
    }
    await app.withTenant(state.tenantId, async () => {
      const existing = (await listMcpIntegrations(state.tenantId)).filter((entry) => entry.slug !== pending.slug)
      existing.push({
        slug: pending.slug,
        label: pending.label,
        url: pending.url,
        category: pending.category,
        oauth: grant,
      })
      await saveMcpIntegrations(state.tenantId, existing)
    })
    return { ok: true, label: pending.label, toolCount }
  } catch (error) {
    return { ok: false, message: messageOf(error) }
  }
}

// --- Access tokens ---------------------------------------------------------

type StoredTokens = { accessToken: string; tokenType: string; refreshToken?: string; expiresAt?: number }

function sealTokens(tokens: OAuthTokens): SealedSecret {
  const stored: StoredTokens = {
    accessToken: tokens.accessToken,
    tokenType: tokens.tokenType,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
  }
  return sealSecret(JSON.stringify(stored))
}

/**
 * The Authorization header for one OAuth-connected integration, minting a
 * fresh access token first when the stored one is about to lapse. Call inside
 * an existing tenant scope; a rotated token set is written back in its OWN
 * transaction (the same discipline as mailbox refresh tokens) so it survives
 * even when the surrounding run later fails.
 */
export async function mcpOauthHeaders(tenantId: string, entry: McpIntegrationEntry): Promise<Record<string, string>> {
  const grant = entry.oauth
  if (!grant) throw new Error('this connection has no OAuth grant — reconnect it in Settings → Integrations.')
  const plain = unsealSecret(grant.sealedTokens)
  if (plain === null) {
    throw new Error('its sign-in tokens cannot be unsealed (APPKIT_SECRET changed?) — reconnect it in Settings → Integrations.')
  }
  let tokens = JSON.parse(plain) as StoredTokens

  const stale = typeof tokens.expiresAt === 'number' && tokens.expiresAt - Date.now() < EXPIRY_SLACK_MS
  if (stale) {
    if (!tokens.refreshToken) {
      throw new Error('its sign-in has expired and the server issued no refresh token — reconnect it in Settings → Integrations.')
    }
    const clientSecret = grant.sealedClientSecret ? unsealSecret(grant.sealedClientSecret) : null
    const refreshed = await refreshTokens({
      authorization: { tokenEndpoint: grant.tokenEndpoint, resource: grant.resource },
      client: { clientId: grant.clientId, ...(clientSecret ? { clientSecret } : {}) },
      refreshToken: tokens.refreshToken,
    })
    await persistRotatedTokens(tenantId, entry.slug, sealTokens(refreshed))
    tokens = {
      accessToken: refreshed.accessToken,
      tokenType: refreshed.tokenType,
      ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
      ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
    }
  }
  return { Authorization: `${tokens.tokenType} ${tokens.accessToken}` }
}

/**
 * Write a rotated token set in an independent transaction — servers may
 * rotate the refresh token on every mint and expect the old one dropped, so
 * losing this write would lock the integration out.
 */
async function persistRotatedTokens(tenantId: string, slug: string, sealedTokens: SealedSecret): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    const entries = await listMcpIntegrations(tenantId)
    const next = entries.map((entry) =>
      entry.slug === slug && entry.oauth ? { ...entry, oauth: { ...entry.oauth, sealedTokens } } : entry,
    )
    await saveMcpIntegrations(tenantId, next)
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
