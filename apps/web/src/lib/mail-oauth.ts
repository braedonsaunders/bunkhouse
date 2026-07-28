import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { and, eq } from 'drizzle-orm'
import { sealSecret, unsealSecret, type SealedSecret } from '@appkit/crypto'
import { verifyImap, verifySmtp, type MailboxConnection } from '@appkit/mailbox'
import {
  mailboxAccounts,
  people,
  tenantSettings,
  MAIL_OAUTH_APPS_KEY,
  type MailOauthAppSettings,
} from '../db/schema'
import { db } from '../db/client'

/**
 * Signing an agent's mailbox in with the company's own Google Workspace or
 * Microsoft 365 application.
 *
 * The mail engine stays IMAP/SMTP — Google and Microsoft both speak it, they
 * just require XOAUTH2 instead of a password (Microsoft has retired basic auth
 * for those protocols entirely). So this module owns exactly the credential
 * lifecycle: the authorization redirect, the code exchange, and minting a
 * short-lived access token from the stored refresh token on every operation.
 *
 * Nothing long-lived is ever handed to the transport. The company's client
 * secret is sealed in tenant settings; each mailbox's refresh token is sealed
 * on its own account row. Microsoft issues a NEW refresh token on most
 * refreshes and expects the old one to be dropped, so a rotated token is
 * written back in its own committed transaction before the access token is
 * returned — losing that write would lock the mailbox out.
 */

export type MailOauthProvider = 'google' | 'microsoft'

export function isMailOauthProvider(value: string): value is MailOauthProvider {
  return value === 'google' || value === 'microsoft'
}

type ProviderSpec = {
  label: string
  /** The mailbox_accounts.provider value a mailbox connected this way carries. */
  accountProvider: 'gmail' | 'microsoft'
  /** Space-delimited scope string sent to the authorization and token endpoints. */
  scopes: string
  imap: { host: string; port: number; secure: boolean }
  smtp: { host: string; port: number; secure: boolean }
  authorizeUrl: (directory: string) => string
  tokenUrl: (directory: string) => string
  /** Provider-specific authorization parameters (Google needs both to return a refresh token). */
  authorizeParams: Record<string, string>
}

const PROVIDERS: Record<MailOauthProvider, ProviderSpec> = {
  google: {
    label: 'Google Workspace',
    accountProvider: 'gmail',
    scopes: 'https://mail.google.com/ openid email',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    authorizeUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    // Google only returns a refresh token for an offline grant, and only
    // re-issues one when consent is asked for again.
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
  },
  microsoft: {
    label: 'Microsoft 365',
    accountProvider: 'microsoft',
    scopes:
      'https://outlook.office365.com/IMAP.AccessAsUser.All https://outlook.office365.com/SMTP.Send offline_access openid email',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    // Microsoft's SMTP endpoint is STARTTLS on 587, not implicit TLS.
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    authorizeUrl: (directory) => `https://login.microsoftonline.com/${directory}/oauth2/v2.0/authorize`,
    tokenUrl: (directory) => `https://login.microsoftonline.com/${directory}/oauth2/v2.0/token`,
    authorizeParams: { prompt: 'consent' },
  },
}

/** The default Microsoft directory: any work, school, or personal account. */
const DEFAULT_MICROSOFT_DIRECTORY = 'common'

/** How long an in-flight authorization may take before its state is refused. */
const STATE_MAX_AGE_MS = 10 * 60 * 1000

const OUTBOUND_TIMEOUT_MS = 15_000

/** The one redirect URI both providers call back to; shown in Settings for copy-paste. */
export function mailOauthRedirectUri(): string {
  const base = process.env.APP_URL ?? 'http://localhost:4810'
  return `${base.replace(/\/+$/, '')}/api/mail-oauth/callback`
}

// --- Hardened egress --------------------------------------------------------

// bunkhouse does not depend on @appkit/sync, so this is the local equivalent of
// that package's secureFetch guarantees, narrowed to the one shape needed here:
// an HTTPS form POST to a provider token endpoint, every resolved address
// public, redirects refused outright, and a hard 15-second ceiling.

const blockedIpv4 = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedIpv4.addSubnet(network, prefix, 'ipv4')
}

// Kept separate from the IPv4 list: Node's BlockList treats IPv4 input as an
// IPv4-mapped IPv6 address once a mapped subnet is present, which would make a
// combined list reject every IPv4 answer.
const blockedIpv6 = new BlockList()
for (const [network, prefix] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['100::', 64],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blockedIpv6.addSubnet(network, prefix, 'ipv6')
}
blockedIpv6.addAddress('::1', 'ipv6')

function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blockedIpv4.check(address, 'ipv4')
  if (family === 6) return !blockedIpv6.check(address, 'ipv6')
  return false
}

async function assertPublicHttpsEndpoint(url: URL): Promise<void> {
  if (url.protocol !== 'https:') {
    throw new Error('Sign-in endpoints must be HTTPS.')
  }
  const answers = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true })
  if (answers.length === 0 || answers.some((answer) => !isPublicAddress(answer.address))) {
    throw new Error(`${url.hostname} does not resolve to a public address.`)
  }
}

type TokenResponse = {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

async function postForm(endpoint: string, form: URLSearchParams): Promise<TokenResponse> {
  const url = new URL(endpoint)
  await assertPublicHttpsEndpoint(url)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
  })
  const body = await response.text()
  let payload: TokenResponse
  try {
    payload = JSON.parse(body) as TokenResponse
  } catch {
    throw new Error(`${url.hostname} returned an unreadable response (HTTP ${response.status}).`)
  }
  if (!response.ok || payload.error) {
    const detail = payload.error_description ?? payload.error ?? `HTTP ${response.status}`
    throw new Error(`${url.hostname} refused the sign-in: ${detail}`)
  }
  return payload
}

// --- Tenant settings --------------------------------------------------------

/** Reader for callers that already hold a tenant scope. */
async function readMailOauthApps(tenantId: string): Promise<MailOauthAppSettings> {
  const app = db()
  const [row] = await app.db
    .select({ value: tenantSettings.value })
    .from(tenantSettings)
    .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, MAIL_OAUTH_APPS_KEY)))
  return (row?.value as MailOauthAppSettings | undefined) ?? {}
}

async function writeMailOauthApps(tenantId: string, value: MailOauthAppSettings): Promise<void> {
  const app = db()
  await app.db
    .insert(tenantSettings)
    .values({ tenantId, key: MAIL_OAUTH_APPS_KEY, value })
    .onConflictDoUpdate({
      target: [tenantSettings.tenantId, tenantSettings.key],
      set: { value, updatedAt: new Date() },
    })
}

/** The configured applications, secrets still sealed — safe to render. */
async function getMailOauthApps(tenantId: string): Promise<MailOauthAppSettings> {
  const app = db()
  return app.withTenantContext(tenantId, () => readMailOauthApps(tenantId))
}

export type MailOauthAppSummary = {
  provider: MailOauthProvider
  label: string
  clientId: string
  /** Microsoft only: the Entra directory the application is registered in. */
  directory: string | null
}

/** What Settings renders: which applications exist, without their secrets. */
export async function listMailOauthApps(tenantId: string): Promise<MailOauthAppSummary[]> {
  const apps = await getMailOauthApps(tenantId)
  const views: MailOauthAppSummary[] = []
  if (apps.google) {
    views.push({ provider: 'google', label: PROVIDERS.google.label, clientId: apps.google.clientId, directory: null })
  }
  if (apps.microsoft) {
    views.push({
      provider: 'microsoft',
      label: PROVIDERS.microsoft.label,
      clientId: apps.microsoft.clientId,
      directory: apps.microsoft.tenant,
    })
  }
  return views
}

/** Store (or replace) the company's application for one provider. */
export async function saveMailOauthApp(input: {
  tenantId: string
  provider: MailOauthProvider
  clientId: string
  clientSecret: string
  /** Microsoft only; defaults to 'common'. */
  directory?: string
}): Promise<void> {
  const clientId = input.clientId.trim()
  const clientSecret = input.clientSecret.trim()
  if (!clientId) throw new Error('Enter the application (client) ID.')
  if (!clientSecret) throw new Error('Enter the client secret.')
  const app = db()
  await app.withTenant(input.tenantId, async () => {
    const current = await readMailOauthApps(input.tenantId)
    const next: MailOauthAppSettings =
      input.provider === 'google'
        ? { ...current, google: { clientId, sealedClientSecret: sealSecret(clientSecret) } }
        : {
            ...current,
            microsoft: {
              clientId,
              sealedClientSecret: sealSecret(clientSecret),
              tenant: input.directory?.trim() || DEFAULT_MICROSOFT_DIRECTORY,
            },
          }
    await writeMailOauthApps(input.tenantId, next)
  })
}

/** Remove an application. Mailboxes already connected keep working until their
 *  refresh fails — at which point they report the missing application. */
export async function removeMailOauthApp(tenantId: string, provider: MailOauthProvider): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    const current = await readMailOauthApps(tenantId)
    const next = { ...current }
    delete next[provider]
    await writeMailOauthApps(tenantId, next)
  })
}

type ResolvedApp = {
  provider: MailOauthProvider
  spec: ProviderSpec
  clientId: string
  clientSecret: string
  directory: string
}

/** Unseal one provider's application for a token exchange. */
async function resolveApp(tenantId: string, provider: MailOauthProvider): Promise<ResolvedApp> {
  const apps = await readMailOauthApps(tenantId)
  const spec = PROVIDERS[provider]
  const entry = provider === 'google' ? apps.google : apps.microsoft
  if (!entry) {
    throw new Error(`No ${spec.label} application is configured. Add one in Settings → Mailboxes.`)
  }
  const clientSecret = unsealSecret(entry.sealedClientSecret)
  if (clientSecret === null) {
    throw new Error(`The ${spec.label} client secret cannot be unsealed (APPKIT_SECRET changed?). Re-enter it in Settings → Mailboxes.`)
  }
  return {
    provider,
    spec,
    clientId: entry.clientId,
    clientSecret,
    directory: provider === 'microsoft' && apps.microsoft ? apps.microsoft.tenant : DEFAULT_MICROSOFT_DIRECTORY,
  }
}

// --- Authorization state ----------------------------------------------------

type OauthState = {
  tenantId: string
  personId: string
  provider: MailOauthProvider
  /** PKCE code verifier — sealed with the rest of the state, never sent to the browser in the clear. */
  verifier: string
  nonce: string
  ts: number
}

function sealState(state: OauthState): string {
  return Buffer.from(JSON.stringify(sealSecret(JSON.stringify(state))), 'utf8').toString('base64url')
}

function openState(encoded: string): OauthState {
  let sealed: SealedSecret
  try {
    sealed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SealedSecret
  } catch {
    throw new Error('That sign-in link is not valid. Start the connection again from the agent’s Mailbox tab.')
  }
  const plain = unsealSecret(sealed)
  if (plain === null) {
    throw new Error('That sign-in could not be verified. Start the connection again from the agent’s Mailbox tab.')
  }
  const state = JSON.parse(plain) as OauthState
  if (
    typeof state.tenantId !== 'string' ||
    typeof state.personId !== 'string' ||
    typeof state.verifier !== 'string' ||
    typeof state.ts !== 'number' ||
    !isMailOauthProvider(state.provider)
  ) {
    throw new Error('That sign-in could not be verified. Start the connection again from the agent’s Mailbox tab.')
  }
  if (Date.now() - state.ts > STATE_MAX_AGE_MS) {
    throw new Error('That sign-in took too long to finish. Start the connection again from the agent’s Mailbox tab.')
  }
  return state
}

/**
 * The agent a callback belongs to, without exchanging anything — used to send
 * the operator back to the right record when the provider reports a refusal.
 */
export function mailOauthStatePerson(encoded: string): string | null {
  try {
    return openState(encoded).personId
  } catch {
    return null
  }
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/** Build the provider's consent URL for one agent's mailbox. */
export async function beginMailOauth(input: {
  tenantId: string
  personId: string
  provider: MailOauthProvider
}): Promise<{ url: string }> {
  const app = db()
  const resolved = await app.withTenantContext(input.tenantId, () => resolveApp(input.tenantId, input.provider))
  const { verifier, challenge } = pkce()
  const state = sealState({
    tenantId: input.tenantId,
    personId: input.personId,
    provider: input.provider,
    verifier,
    nonce: randomBytes(16).toString('base64url'),
    ts: Date.now(),
  })
  const url = new URL(resolved.spec.authorizeUrl(resolved.directory))
  for (const [key, value] of Object.entries({
    client_id: resolved.clientId,
    response_type: 'code',
    redirect_uri: mailOauthRedirectUri(),
    scope: resolved.spec.scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...resolved.spec.authorizeParams,
  })) {
    url.searchParams.set(key, value)
  }
  return { url: url.toString() }
}

// --- Identity ---------------------------------------------------------------

/**
 * Read the mailbox address out of the id_token. The token came straight from
 * the provider's token endpoint over a verified TLS connection we just made,
 * so its signature adds nothing here; the audience check is what matters — it
 * proves the token was minted for this company's application.
 */
function addressFromIdToken(idToken: string, clientId: string): string {
  const segments = idToken.split('.')
  if (segments.length !== 3) throw new Error('The provider did not return a readable identity token.')
  let claims: Record<string, unknown>
  try {
    claims = JSON.parse(Buffer.from(segments[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    throw new Error('The provider did not return a readable identity token.')
  }
  const audience = claims.aud
  const audiences = Array.isArray(audience) ? audience : [audience]
  if (!audiences.includes(clientId)) {
    throw new Error('The sign-in was issued for a different application. Check the client ID in Settings → Mailboxes.')
  }
  const candidate = [claims.email, claims.preferred_username, claims.upn].find(
    (value): value is string => typeof value === 'string' && value.includes('@'),
  )
  if (!candidate) {
    throw new Error('The provider did not return an email address for that account. Sign in with a mailbox-enabled account.')
  }
  return candidate.trim().toLowerCase()
}

// --- Completion -------------------------------------------------------------

export type CompleteMailOauthResult =
  | { ok: true; personId: string; address: string; provider: MailOauthProvider }
  | { ok: false; personId: string | null; message: string }

/**
 * Finish the provider round-trip: validate the state, exchange the code, and
 * put the agent's mailbox online. Returns a result rather than throwing so the
 * callback route can send the operator back to the agent with a readable
 * explanation instead of an error page.
 */
export async function completeMailOauth(input: {
  state: string
  code: string
  redirectUri: string
}): Promise<CompleteMailOauthResult> {
  let state: OauthState
  try {
    state = openState(input.state)
  } catch (error) {
    return { ok: false, personId: null, message: messageOf(error) }
  }
  try {
    const app = db()
    const resolved = await app.withTenantContext(state.tenantId, () => resolveApp(state.tenantId, state.provider))
    const tokens = await postForm(
      resolved.spec.tokenUrl(resolved.directory),
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: resolved.clientId,
        client_secret: resolved.clientSecret,
        code_verifier: state.verifier,
        scope: resolved.spec.scopes,
      }),
    )
    if (!tokens.id_token) {
      throw new Error('The provider did not return an identity token, so the mailbox address is unknown.')
    }
    if (!tokens.refresh_token) {
      throw new Error(
        state.provider === 'google'
          ? 'Google did not issue a long-lived token for this account, which usually means the account has already approved this application. Remove the application under the account’s third-party access settings, then connect again.'
          : 'Microsoft did not issue a long-lived token for this account. Make sure the application requests offline access and try again.',
      )
    }
    const address = addressFromIdToken(tokens.id_token, resolved.clientId)
    if (!tokens.access_token) {
      throw new Error('The provider did not return an access token, so the mailbox could not be reached.')
    }
    await verifyEndpoints(resolved.spec, address, tokens.access_token)
    await linkMailbox({
      tenantId: state.tenantId,
      personId: state.personId,
      address,
      spec: resolved.spec,
      refreshToken: tokens.refresh_token,
    })
    return { ok: true, personId: state.personId, address, provider: state.provider }
  } catch (error) {
    return { ok: false, personId: state.personId, message: messageOf(error) }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Prove the granted token actually opens the mailbox before anything is
 * stored — the same contract the IMAP connect form holds itself to. This is
 * where the two common setup mistakes surface: IMAP switched off in Gmail,
 * and SMTP AUTH disabled tenant-wide in Microsoft 365 (its default).
 */
async function verifyEndpoints(spec: ProviderSpec, address: string, accessToken: string): Promise<void> {
  const connection: MailboxConnection = {
    address,
    imap: spec.imap,
    smtp: spec.smtp,
    username: address,
    password: '',
    accessToken,
  }
  try {
    await verifyImap(connection)
  } catch (error) {
    throw new Error(
      `${spec.label} accepted the sign-in but refused IMAP for ${address}: ${messageOf(error)}. Check that IMAP is enabled for this mailbox.`,
    )
  }
  try {
    await verifySmtp(connection)
  } catch (error) {
    throw new Error(
      `${spec.label} accepted the sign-in but refused SMTP for ${address}: ${messageOf(error)}. Check that authenticated SMTP is enabled for this mailbox.`,
    )
  }
}

/** The sealed payload behind an OAuth mailbox's secretRef. */
type OauthSecret = { kind: 'oauth'; refreshToken: string }

function sealRefreshToken(refreshToken: string): string {
  return JSON.stringify(sealSecret(JSON.stringify({ kind: 'oauth', refreshToken } satisfies OauthSecret)))
}

/** Create or re-point the agent's mailbox account, and bring the agent online. */
async function linkMailbox(input: {
  tenantId: string
  personId: string
  address: string
  spec: ProviderSpec
  refreshToken: string
}): Promise<void> {
  const app = db()
  await app.withTenant(input.tenantId, async () => {
    const [claimed] = await app.db
      .select({ id: mailboxAccounts.id, personId: mailboxAccounts.personId })
      .from(mailboxAccounts)
      .where(eq(mailboxAccounts.address, input.address))
    if (claimed && claimed.personId !== input.personId) {
      throw new Error(`${input.address} is already connected to another agent.`)
    }
    const values = {
      address: input.address,
      provider: input.spec.accountProvider,
      status: 'active' as const,
      imap: {
        imapHost: input.spec.imap.host,
        imapPort: input.spec.imap.port,
        imapSecure: input.spec.imap.secure,
        smtpHost: input.spec.smtp.host,
        smtpPort: input.spec.smtp.port,
        smtpSecure: input.spec.smtp.secure,
        username: input.address,
      },
      secretRef: sealRefreshToken(input.refreshToken),
      lastError: null,
    }
    const [existing] = await app.db
      .select({ id: mailboxAccounts.id, address: mailboxAccounts.address })
      .from(mailboxAccounts)
      .where(eq(mailboxAccounts.personId, input.personId))
    if (existing) {
      // Re-authorizing the SAME address keeps its sync cursor, so the ledger
      // does not re-ingest everything the agent has already handled. Pointing
      // the agent at a different address starts that mailbox from the top.
      const movedAddress = existing.address !== input.address
      await app.db
        .update(mailboxAccounts)
        .set({ ...values, ...(movedAddress ? { syncCursor: null } : {}), updatedAt: new Date() })
        .where(eq(mailboxAccounts.id, existing.id))
    } else {
      await app.db.insert(mailboxAccounts).values({ tenantId: input.tenantId, personId: input.personId, ...values })
    }
    await app.db.update(people).set({ status: 'active' }).where(eq(people.id, input.personId))
  })
}

// --- Access tokens ----------------------------------------------------------

type Account = typeof mailboxAccounts.$inferSelect

/** Which OAuth provider an account row was connected through, if any. */
export function mailOauthProviderOf(account: Account): MailOauthProvider | null {
  if (account.provider === 'gmail') return 'google'
  if (account.provider === 'microsoft') return 'microsoft'
  return null
}

/**
 * Mint a fresh access token for one OAuth mailbox. Call inside an existing
 * tenant scope — the caller's scope is reused for reads, and the rotated-token
 * write-back deliberately runs in its OWN transaction so it survives even if
 * the surrounding work (a send, say) later fails and rolls back.
 */
export async function freshAccessToken(
  tenantId: string,
  account: Account,
): Promise<{ accessToken: string; username: string }> {
  const provider = mailOauthProviderOf(account)
  if (!provider) throw new Error('This mailbox is not connected through Google Workspace or Microsoft 365.')
  const sealed = JSON.parse(account.secretRef) as SealedSecret
  const plain = unsealSecret(sealed)
  if (plain === null) {
    throw new Error('This mailbox’s stored credential cannot be unsealed (APPKIT_SECRET changed?). Reconnect the mailbox.')
  }
  const secret = JSON.parse(plain) as OauthSecret
  if (secret.kind !== 'oauth' || !secret.refreshToken) {
    throw new Error('This mailbox’s stored credential is not a sign-in token. Reconnect the mailbox.')
  }

  const resolved = await resolveApp(tenantId, provider)
  const tokens = await postForm(
    resolved.spec.tokenUrl(resolved.directory),
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: secret.refreshToken,
      client_id: resolved.clientId,
      client_secret: resolved.clientSecret,
      scope: resolved.spec.scopes,
    }),
  )
  if (!tokens.access_token) {
    throw new Error(`${resolved.spec.label} did not return an access token for this mailbox. Reconnect it.`)
  }
  // Microsoft rotates the refresh token on most refreshes and expects the
  // previous one to be discarded. Persist the replacement before the access
  // token is used for anything, in its own committed transaction.
  if (tokens.refresh_token && tokens.refresh_token !== secret.refreshToken) {
    await persistRotatedRefreshToken(tenantId, account.id, tokens.refresh_token)
  }
  return { accessToken: tokens.access_token, username: account.imap?.username ?? account.address }
}

/**
 * Write a rotated refresh token in an independent transaction. Nested
 * withTenant acquires its own connection and commits on its own, so this
 * cannot be undone by a rollback in the operation that triggered the refresh —
 * and it stays RLS-enforced rather than reaching for the super pool.
 */
async function persistRotatedRefreshToken(tenantId: string, accountId: string, refreshToken: string): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .update(mailboxAccounts)
      .set({ secretRef: sealRefreshToken(refreshToken), updatedAt: new Date() })
      .where(eq(mailboxAccounts.id, accountId))
  })
}

/**
 * Record a credential failure on the mailbox, the same way a failed sync does.
 * Independently committed for the same reason as the rotation write-back: the
 * operator must see why the mailbox stopped, even when the caller unwinds.
 */
export async function recordMailboxError(tenantId: string, accountId: string, message: string): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .update(mailboxAccounts)
      .set({ status: 'error', lastError: message, updatedAt: new Date() })
      .where(eq(mailboxAccounts.id, accountId))
  })
}
