import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { sealSecret, unsealSecret, type SealedSecret } from '@appkit/crypto'
import {
  buildAuthorizationUrl,
  createPkce,
  discoverAuthorization,
  exchangeAuthorizationCode,
  isClientAssertionAlgorithm,
  mintClientCredentialsToken,
  refreshTokens,
  registerClient,
  type OAuthTokens,
} from '@appkit/oauth'
import { connectMcpServers } from '@bunkhouse/runtime'
import {
  tenantSettings,
  MCP_OAUTH_PENDING_KEY,
  type McpIntegrationEntry,
  type McpM2mGrant,
  type McpOauthGrant,
  type McpOauthPending,
} from '../db/schema'
import { db } from '../db/client'
import { listMcpIntegrations, recordMcpHealth, saveMcpIntegrations } from './mcp-integrations'
import { appUrl } from './app-origin'

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

/**
 * Where providers send the operator back. Derived from the request being
 * served, so a deployment needs no configuration to sign in correctly — see
 * `appOrigin` for the resolution order and why there is no localhost fallback.
 *
 * The value used to start an authorization is stored with the pending record
 * and replayed at the token exchange, so the two always match even if the
 * second request arrives on a different hostname.
 */
export async function mcpOauthRedirectUri(): Promise<string> {
  return appUrl('/api/mcp-oauth/callback')
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
 * Register this company as an application with the provider, or explain what
 * to do instead when it will not.
 *
 * Automatic registration is a courtesy, not a guarantee. Plenty of enterprise
 * servers advertise a registration endpoint and still refuse every callback
 * that an administrator has not allowlisted in their own console first —
 * NetSuite is one. Left raw, the provider's answer to that is
 * `invalid_redirect_uri`, which reads exactly like a wrong address and sends an
 * operator off checking a URI that was never the problem.
 *
 * So a registration failure says what it actually means: this server wants the
 * application made by hand, and here is the one field to bring back.
 */
async function registerApplication(args: {
  authorization: Awaited<ReturnType<typeof discoverAuthorization>>
  redirectUri: string
  host: string
}): Promise<{ clientId: string; clientSecret?: string }> {
  try {
    return await registerClient({
      authorization: args.authorization,
      redirectUri: args.redirectUri,
      clientName: 'Bunkhouse',
    })
  } catch (error) {
    const detail = messageOf(error)
    // A refused callback is the provider saying "allowlist it first", not that
    // the address is malformed — say so, and name the two things to do.
    if (/invalid_redirect_uri|redirect/i.test(detail)) {
      throw new Error(
        `${args.host} would not register an application automatically: it only accepts callback addresses an administrator has already approved. Create an application in ${args.host}, give it exactly this redirect URI — ${args.redirectUri} — then paste its Client ID above and connect again.`,
      )
    }
    throw new Error(
      `${args.host} would not register an application automatically (${detail}). Create one in ${args.host} with ${args.redirectUri} as its redirect URI, then paste its Client ID above and connect again.`,
    )
  }
}

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
  const redirectUri = await mcpOauthRedirectUri()
  const authorization = await discoverAuthorization(input.url)
  const client = input.clientId
    ? { clientId: input.clientId, ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}) }
    : await registerApplication({ authorization, redirectUri, host: new URL(input.url).hostname })

  const pkce = createPkce()
  const nonce = randomBytes(16).toString('base64url')
  const pending: McpOauthPending = {
    nonce,
    slug: input.slug,
    label: input.label,
    url: input.url,
    category: input.category,
    redirectUri,
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
      redirectUri: pending.redirectUri ?? (await mcpOauthRedirectUri()),
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
      const all = await listMcpIntegrations(state.tenantId)
      const previous = all.find((entry) => entry.slug === pending.slug)
      const existing = all.filter((entry) => entry.slug !== pending.slug)
      existing.push({
        slug: pending.slug,
        label: pending.label,
        url: pending.url,
        category: pending.category,
        oauth: grant,
        // Signing in again keeps who the system was granted to; a first
        // sign-in starts in every agent's toolbox, as a fresh connection does.
        assignment: previous?.assignment ?? { everyone: true },
      })
      await saveMcpIntegrations(state.tenantId, existing)
      // The probe above already proved this connection answers, and signing in
      // is the single most likely moment for a failed one to have been fixed.
      // Without this the row keeps the old failure until the next housekeeping
      // sweep — so the screen contradicts the sign-in the operator just
      // completed, which reads as the sign-in not having worked.
      await recordMcpHealth(state.tenantId, pending.slug, {
        status: 'ok',
        checkedAt: Date.now(),
        toolCount,
      })
    })
    // A connection that has just been re-signed-in may have held a certificate
    // before; a token minted under it must not outlive the credential.
    forgetMintedTokens(state.tenantId, pending.slug)
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

function isStale(tokens: StoredTokens, slackMs: number = EXPIRY_SLACK_MS): boolean {
  return typeof tokens.expiresAt === 'number' && tokens.expiresAt - Date.now() < slackMs
}

function readStoredTokens(grant: McpOauthGrant): StoredTokens {
  const plain = unsealSecret(grant.sealedTokens)
  if (plain === null) {
    throw new Error('its sign-in tokens cannot be unsealed (APPKIT_SECRET changed?) — reconnect it under Resources → Systems.')
  }
  return JSON.parse(plain) as StoredTokens
}

/**
 * The grant as it stands now, not as the caller last saw it.
 *
 * A caller holds a connection it read at some earlier point — the start of a
 * housekeeping sweep, the top of a run — and in between, anything else may
 * have rotated the tokens. That matters more than it sounds, because a
 * provider may invalidate the OLD access token the moment it issues a new one:
 * NetSuite does, and the symptom is a 401 with an empty body, which surfaces
 * as the bare string "Error POSTing to endpoint: " with nothing after the
 * colon. Measured: a health probe 138ms after a renewal, using the snapshot
 * from before it, was refused — and the same probe on any pass that did not
 * renew succeeded.
 *
 * So the credential is read here rather than trusted from the argument. One
 * indexed settings read against an MCP dial is not a cost worth optimising,
 * and it removes the whole class rather than the instance that was noticed.
 */
async function currentGrant(tenantId: string, entry: McpIntegrationEntry): Promise<McpOauthGrant> {
  const fresh = (await listMcpIntegrations(tenantId)).find((candidate) => candidate.slug === entry.slug)
  return fresh?.oauth ?? entry.oauth!
}

/**
 * The Authorization header for one OAuth-connected integration, minting a
 * fresh access token first when the stored one is about to lapse. Call inside
 * an existing tenant scope.
 */
export async function mcpOauthHeaders(tenantId: string, entry: McpIntegrationEntry): Promise<Record<string, string>> {
  if (!entry.oauth) throw new Error('this connection has no OAuth grant — reconnect it under Resources → Systems.')
  const grant = await currentGrant(tenantId, entry)
  const stored = readStoredTokens(grant)
  const tokens = isStale(stored) ? await refreshSharedTokens(tenantId, entry.slug, grant, EXPIRY_SLACK_MS) : stored
  return { Authorization: `${tokens.tokenType} ${tokens.accessToken}` }
}

/** In-flight refreshes in THIS process, so concurrent runs mint once between them. */
const refreshInFlight = new Map<string, Promise<StoredTokens>>()

/**
 * Advisory-lock namespace for MCP credential writes. Paired with a hash of the
 * connection's key so two features cannot collide on the same lock id.
 */
const MCP_LOCK_NAMESPACE = 0x6d63

/**
 * Refresh one grant, once, however many runs want it at the same moment.
 *
 * A rotating refresh token cannot be minted from twice. Providers that rotate —
 * NetSuite among them — invalidate the old token the instant a new one is
 * issued, so two concurrent refreshes do not merely race to write: the second
 * mint presents a token the first already destroyed, and whichever write lands
 * last can leave a dead credential behind. Serialising the write alone is not
 * enough; the *mint* is what has to be exclusive.
 *
 * Two layers, because concurrency arrives from two directions. A promise map
 * collapses the common case — several runs in one worker starting together. A
 * Postgres advisory lock covers the rest, and the re-read inside it means a
 * process that waited for the lock uses the token the winner just stored rather
 * than spending a second mint on the same work.
 *
 * The lock is held across the token request. That is deliberate: releasing it
 * earlier would reopen exactly the window it exists to close. The hold is
 * bounded by the OAuth egress timeout and happens about once an hour per
 * connection, which is a cheap price for a credential that cannot be corrupted.
 */
async function refreshSharedTokens(
  tenantId: string,
  slug: string,
  fallback: McpOauthGrant,
  /** How much life left still counts as spent — wider when renewing early. */
  slackMs: number,
): Promise<StoredTokens> {
  const key = `${tenantId}:${slug}`
  const existing = refreshInFlight.get(key)
  if (existing) return existing

  const work = (async (): Promise<StoredTokens> => {
    const app = db()
    return app.withTenant(tenantId, async () => {
      await app.db.execute(sql`select pg_advisory_xact_lock(${MCP_LOCK_NAMESPACE}, hashtext(${key}))`)

      // Re-read under the lock: another process may have refreshed while we
      // queued, and its token set is the only valid one now.
      const entries = await listMcpIntegrations(tenantId)
      const grant = entries.find((entry) => entry.slug === slug)?.oauth ?? fallback
      const stored = readStoredTokens(grant)
      if (!isStale(stored, slackMs)) return stored

      if (!stored.refreshToken) {
        throw new Error(
          'its sign-in has expired and the server issued no refresh token — reconnect it under Resources → Systems.',
        )
      }
      const clientSecret = grant.sealedClientSecret ? unsealSecret(grant.sealedClientSecret) : null
      const refreshed = await refreshTokens({
        authorization: { tokenEndpoint: grant.tokenEndpoint, resource: grant.resource },
        client: { clientId: grant.clientId, ...(clientSecret ? { clientSecret } : {}) },
        refreshToken: stored.refreshToken,
      })

      const sealed = sealTokens(refreshed)
      await saveMcpIntegrations(
        tenantId,
        entries.map((entry) =>
          entry.slug === slug && entry.oauth ? { ...entry, oauth: { ...entry.oauth, sealedTokens: sealed } } : entry,
        ),
      )
      return {
        accessToken: refreshed.accessToken,
        tokenType: refreshed.tokenType,
        ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
        ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
      }
    })
  })()

  refreshInFlight.set(key, work)
  try {
    return await work
  } finally {
    refreshInFlight.delete(key)
  }
}

/**
 * How long before expiry the housekeeping pass renews a grant. Comfortably
 * wider than the pass interval, so a token is replaced by the scheduler rather
 * than by whichever duty happens to need it first — and so a refresh token that
 * lapses from disuse never gets the chance.
 */
const REFRESH_AHEAD_MS = 30 * 60 * 1000

/**
 * Renew a grant early, outside any run. Returns false when nothing was due.
 * Errors are the caller's to record — this is called from housekeeping, where a
 * provider refusing is the news, not an exception to swallow.
 */
export async function refreshGrantIfDue(tenantId: string, entry: McpIntegrationEntry): Promise<boolean> {
  if (!entry.oauth) return false
  // Same reason as the header path: a snapshot may already have been rotated
  // out from under this caller, and renewing from it would spend a refresh
  // token that is no longer the current one.
  const grant = await currentGrant(tenantId, entry)
  if (!isStale(readStoredTokens(grant), REFRESH_AHEAD_MS)) return false
  await refreshSharedTokens(tenantId, entry.slug, grant, REFRESH_AHEAD_MS)
  return true
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// --- Machine-to-machine tokens ------------------------------------------------

/**
 * Minted access tokens, held in memory only.
 *
 * There is nothing to persist — the client-credentials grant returns no
 * refresh token — so this is a cache, not a store: losing it costs one token
 * request. That is also why it can be a plain map with no locking, where the
 * authorization-code path needs a database write it must not race.
 *
 * Keyed by tenant, slug, and a fingerprint of the sealed key, so replacing a
 * certificate cannot be served a token minted under the old one.
 */
const mintedTokens = new Map<string, { header: string; expiresAt: number }>()

/** Mint again this long before expiry, so a slow MCP dial cannot outlive it. */
const M2M_EXPIRY_SLACK_MS = 60 * 1000

/** Assume the provider's shortest plausible lifetime when none is reported. */
const M2M_ASSUMED_LIFETIME_MS = 5 * 60 * 1000

function m2mCacheKey(tenantId: string, slug: string, grant: McpM2mGrant): string {
  const fingerprint = createHash('sha256')
    .update(grant.sealedPrivateKey.ciphertext)
    .update(grant.clientId)
    .update(grant.keyId ?? '')
    .digest('base64url')
    .slice(0, 16)
  return `${tenantId}:${slug}:${fingerprint}`
}

/**
 * The Authorization header for one machine-to-machine connection.
 *
 * Every token is minted from the sealed key on demand and nothing is written
 * back, so two runs connecting at the same moment cannot corrupt each other's
 * credential — the failure mode that a rotating refresh token has, and the
 * reason a system agents depend on daily belongs on this flow.
 */
export async function mcpM2mHeaders(tenantId: string, entry: McpIntegrationEntry): Promise<Record<string, string>> {
  const grant = entry.m2m
  if (!grant) throw new Error('this connection has no certificate — reconnect it under Resources → Systems.')

  const cacheKey = m2mCacheKey(tenantId, entry.slug, grant)
  const cached = mintedTokens.get(cacheKey)
  if (cached && cached.expiresAt - Date.now() > M2M_EXPIRY_SLACK_MS) return { Authorization: cached.header }

  const privateKey = unsealSecret(grant.sealedPrivateKey)
  if (privateKey === null) {
    throw new Error(
      'its private key cannot be unsealed (APPKIT_SECRET changed?) — reconnect it under Resources → Systems.',
    )
  }
  if (!isClientAssertionAlgorithm(grant.algorithm)) {
    throw new Error(`${grant.algorithm} is not a signing algorithm this can use — reconnect it under Resources → Systems.`)
  }

  const tokens = await mintClientCredentialsToken({
    authorization: { tokenEndpoint: grant.tokenEndpoint, resource: grant.resource },
    client: {
      clientId: grant.clientId,
      privateKey,
      algorithm: grant.algorithm,
      ...(grant.keyId ? { keyId: grant.keyId } : {}),
    },
    ...(grant.scope ? { scope: grant.scope } : {}),
  })

  const header = `${tokens.tokenType} ${tokens.accessToken}`
  mintedTokens.set(cacheKey, {
    header,
    expiresAt: tokens.expiresAt ?? Date.now() + M2M_ASSUMED_LIFETIME_MS,
  })
  return { Authorization: header }
}

/**
 * Forget any token minted for this connection. Called when its credential
 * changes, so a reconnect takes effect on the next run rather than whenever
 * the previous hour happened to run out.
 */
export function forgetMintedTokens(tenantId: string, slug: string): void {
  const prefix = `${tenantId}:${slug}:`
  for (const key of mintedTokens.keys()) {
    if (key.startsWith(prefix)) mintedTokens.delete(key)
  }
}

/**
 * Everything needed to reach a server as ourselves, worked out from the
 * server's own metadata and proved against it before an operator is told the
 * connection is good.
 *
 * The check is deliberately end to end: discovery says the flow exists, the
 * mint says the certificate is actually mapped to an entity and role at the
 * provider, and the caller then dials MCP with the token. A connection that
 * saves without all three reads as healthy until the first duty needs it.
 */
export async function verifyM2mGrant(input: {
  url: string
  clientId: string
  privateKey: string
  algorithm: string
  keyId?: string
  scope?: string
}): Promise<{ grant: Omit<McpM2mGrant, 'sealedPrivateKey'>; headers: Record<string, string> }> {
  if (!isClientAssertionAlgorithm(input.algorithm)) {
    throw new Error(`${input.algorithm} is not a signing algorithm this can use.`)
  }
  const authorization = await discoverAuthorization(input.url)
  const grants = authorization.grantTypesSupported
  if (grants && !grants.includes('client_credentials')) {
    throw new Error(
      `${new URL(authorization.issuer).hostname} does not offer the client-credentials flow (it advertises ${grants.join(', ')}). Sign in with the provider instead.`,
    )
  }
  const algorithms = authorization.tokenEndpointAuthSigningAlgValuesSupported
  if (algorithms && !algorithms.includes(input.algorithm)) {
    throw new Error(
      `${new URL(authorization.issuer).hostname} does not accept ${input.algorithm}-signed assertions — it accepts ${algorithms.join(', ')}.`,
    )
  }
  // The scope the resource itself asks for, unless the operator named one.
  // Providers reject a token minted for the wrong audience with the same
  // opaque error they use for a bad key, so guessing here is expensive.
  const scope = input.scope?.trim() || authorization.scopesSupported?.join(' ')

  const tokens = await mintClientCredentialsToken({
    authorization,
    client: {
      clientId: input.clientId,
      privateKey: input.privateKey,
      algorithm: input.algorithm,
      ...(input.keyId ? { keyId: input.keyId } : {}),
    },
    ...(scope ? { scope } : {}),
  })

  return {
    grant: {
      tokenEndpoint: authorization.tokenEndpoint,
      resource: authorization.resource,
      clientId: input.clientId,
      algorithm: input.algorithm,
      ...(input.keyId ? { keyId: input.keyId } : {}),
      ...(scope ? { scope } : {}),
    },
    headers: { Authorization: `${tokens.tokenType} ${tokens.accessToken}` },
  }
}
