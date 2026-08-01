import 'server-only'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, stat, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import { sealSecret, unsealSecret, type SealedSecret } from '@appkit/crypto'
import {
  files,
  people,
  tenantSettings,
  FILING_SETTINGS_KEY,
  type FilingFileKind,
  type FilingLayout,
  type FilingProvider,
  type FilingSettings,
  type FilingTarget,
} from '../db/schema'
import { fileFilings } from '../db/schema/filing'
import { db } from '../db/client'
import { getFileBytes, type FileRecord } from './files'
import { appUrl } from './app-origin'

/**
 * Filing — a copy of every agent-produced file written into the company's own
 * storage, on top of the files ledger.
 *
 * The ledger and the delivery email are the system of record and always will
 * be: filing is the extra copy that lands where the company already keeps its
 * paperwork. That ordering is the whole design. `fileDeliverable` never
 * throws, never blocks a send, and writes an append-only `file_filings` row
 * for every attempt — a failed copy is a line in Settings → Filing, not a
 * failed deliverable.
 *
 * Three destinations, one seam:
 *
 * - **Google Drive** and **OneDrive / SharePoint** connect by sign-in with the
 *   company's own OAuth application, following the same credential lifecycle
 *   as agent mailboxes (`lib/mail-oauth.ts`): PKCE, a sealed state that never
 *   shows the browser who is connecting what, a sealed refresh token, and a
 *   rotated token written back in its own committed transaction.
 * - **SMB / NAS** is a server-side mounted path. There is no SMB client here
 *   and pretending otherwise would be dishonest: the operator mounts the share
 *   into the container and gives us the directory, which is validated as
 *   genuinely writable before it is saved.
 */

export type { FilingFileKind, FilingLayout, FilingProvider, FilingSettings, FilingTarget }

export const DEFAULT_FILING_SETTINGS: FilingSettings = {
  enabled: false,
  target: null,
  kinds: ['document', 'spreadsheet'],
  layout: 'flat',
  apps: {},
}

/** Ledger kinds that can be filed, in the order the settings screen offers them. */
export const FILING_FILE_KINDS: FilingFileKind[] = ['document', 'spreadsheet', 'attachment']

export const FILING_LAYOUTS: { value: FilingLayout; label: string }[] = [
  { value: 'flat', label: 'One folder' },
  { value: 'agent', label: 'A folder per agent' },
  { value: 'month', label: 'A folder per month' },
]

/** OAuth-connected providers; SMB has no application to register. */
export type FilingOauthProvider = 'google_drive' | 'onedrive'

export function isFilingOauthProvider(value: string): value is FilingOauthProvider {
  return value === 'google_drive' || value === 'onedrive'
}

type ProviderSpec = {
  label: string
  scopes: string
  authorizeUrl: (directory: string) => string
  tokenUrl: (directory: string) => string
  authorizeParams: Record<string, string>
}

const PROVIDERS: Record<FilingOauthProvider, ProviderSpec> = {
  google_drive: {
    label: 'Google Drive',
    // drive.file is the narrowest scope that can hold a filing cabinet: the
    // application sees only the folder it creates and the files it puts there,
    // and nothing else in the company's Drive is ever readable.
    scopes: 'https://www.googleapis.com/auth/drive.file openid email',
    authorizeUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
  },
  onedrive: {
    label: 'OneDrive / SharePoint',
    scopes: 'https://graph.microsoft.com/Files.ReadWrite.All offline_access openid email',
    authorizeUrl: (directory) => `https://login.microsoftonline.com/${directory}/oauth2/v2.0/authorize`,
    tokenUrl: (directory) => `https://login.microsoftonline.com/${directory}/oauth2/v2.0/token`,
    authorizeParams: { prompt: 'consent' },
  },
}

const DEFAULT_MICROSOFT_DIRECTORY = 'common'
const STATE_MAX_AGE_MS = 10 * 60 * 1000
const OUTBOUND_TIMEOUT_MS = 30_000
/** Graph's ceiling for a single-request upload. */
const GRAPH_SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024
/** Upload-session chunk size; Graph requires a multiple of 320 KiB. */
const GRAPH_CHUNK_BYTES = 5 * 320 * 1024

/**
 * The one redirect URI both providers call back to; shown in Settings for
 * copy-paste. Derived from the request being served — see `appOrigin`.
 */
export async function filingOauthRedirectUri(): Promise<string> {
  return appUrl('/api/filing-oauth/callback')
}

// --- Outbound requests ------------------------------------------------------

/**
 * Every host this module talks to is a fixed provider endpoint — no operator
 * input reaches a hostname — so the guard that matters is an allowlist plus
 * refusing redirects, rather than the resolve-and-check dance a user-supplied
 * URL would need. The Microsoft directory segment is operator-supplied and is
 * validated separately before it reaches a path.
 */
const ALLOWED_HOSTS = new Set([
  'accounts.google.com',
  'oauth2.googleapis.com',
  'www.googleapis.com',
  'login.microsoftonline.com',
  'graph.microsoft.com',
])

function assertProviderEndpoint(url: URL): void {
  if (url.protocol !== 'https:') throw new Error('Storage endpoints must be HTTPS.')
  if (!ALLOWED_HOSTS.has(url.hostname)) throw new Error(`${url.hostname} is not a storage provider endpoint.`)
}

function assertMicrosoftDirectory(directory: string): string {
  if (!/^[A-Za-z0-9.-]{1,64}$/.test(directory)) {
    throw new Error('The Microsoft directory must be a directory (tenant) ID or "common".')
  }
  return directory
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
  assertProviderEndpoint(url)
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

/** A provider API call that returns JSON, with the provider's own error text surfaced. */
async function apiJson<T>(
  url: string,
  init: RequestInit & { accessToken: string },
  /** Graph hands out short-lived upload URLs on its own hosts; those are trusted by provenance. */
  allowProviderIssuedHost = false,
): Promise<T> {
  const target = new URL(url)
  if (allowProviderIssuedHost) {
    if (target.protocol !== 'https:') throw new Error('The upload URL the provider returned is not HTTPS.')
  } else {
    assertProviderEndpoint(target)
  }
  const { accessToken, headers, ...rest } = init
  const response = await fetch(target, {
    ...rest,
    headers: { ...(headers as Record<string, string> | undefined), authorization: `Bearer ${accessToken}` },
    redirect: 'error',
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) {
    let detail = ''
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string; error_description?: string }
      if (typeof parsed.error === 'object' && parsed.error?.message) detail = parsed.error.message
      else if (typeof parsed.error === 'string') detail = parsed.error_description ?? parsed.error
    } catch {
      detail = text.trim().slice(0, 200)
    }
    throw new Error(
      `${target.hostname} refused the request (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`,
    )
  }
  if (!text.trim()) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${target.hostname} returned an unreadable response.`)
  }
}

// --- Settings ---------------------------------------------------------------

/** Reader for callers that already hold a tenant scope. */
async function readFilingSettings(tenantId: string): Promise<FilingSettings> {
  const app = db()
  const [row] = await app.db
    .select({ value: tenantSettings.value })
    .from(tenantSettings)
    .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, FILING_SETTINGS_KEY)))
  const stored = row?.value as Partial<FilingSettings> | undefined
  return {
    ...DEFAULT_FILING_SETTINGS,
    ...(stored ?? {}),
    kinds: stored?.kinds?.length ? stored.kinds : DEFAULT_FILING_SETTINGS.kinds,
    apps: stored?.apps ?? {},
  }
}

async function writeFilingSettings(tenantId: string, value: FilingSettings): Promise<void> {
  const app = db()
  await app.db
    .insert(tenantSettings)
    .values({ tenantId, key: FILING_SETTINGS_KEY, value })
    .onConflictDoUpdate({
      target: [tenantSettings.tenantId, tenantSettings.key],
      set: { value, updatedAt: new Date() },
    })
}

/** The tenant's filing configuration, secrets still sealed. */
export async function getFilingSettings(tenantId: string): Promise<FilingSettings> {
  const app = db()
  return app.withTenantContext(tenantId, () => readFilingSettings(tenantId))
}

/** Replace the whole configuration. Callers read, adjust, and write back. */
export async function saveFilingSettings(tenantId: string, value: FilingSettings): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, () => writeFilingSettings(tenantId, value))
}

/** Read-modify-write one part of the configuration inside a single transaction. */
async function mutateFilingSettings(
  tenantId: string,
  change: (current: FilingSettings) => FilingSettings | Promise<FilingSettings>,
): Promise<FilingSettings> {
  const app = db()
  return app.withTenant(tenantId, async () => {
    const next = await change(await readFilingSettings(tenantId))
    await writeFilingSettings(tenantId, next)
    return next
  })
}

/** What Settings renders: the destination and applications, without secrets. */
export type FilingSettingsView = {
  enabled: boolean
  kinds: FilingFileKind[]
  layout: FilingLayout
  target:
    | { provider: FilingProvider; label: string; detail: string; account: string | null }
    | null
  apps: { provider: FilingOauthProvider; label: string; clientId: string; directory: string | null }[]
  redirectUri: string
}

export async function getFilingSettingsView(tenantId: string): Promise<FilingSettingsView> {
  const settings = await getFilingSettings(tenantId)
  const apps: FilingSettingsView['apps'] = []
  if (settings.apps.google) {
    apps.push({
      provider: 'google_drive',
      label: PROVIDERS.google_drive.label,
      clientId: settings.apps.google.clientId,
      directory: null,
    })
  }
  if (settings.apps.microsoft) {
    apps.push({
      provider: 'onedrive',
      label: PROVIDERS.onedrive.label,
      clientId: settings.apps.microsoft.clientId,
      directory: settings.apps.microsoft.tenant,
    })
  }
  return {
    enabled: settings.enabled,
    kinds: settings.kinds,
    layout: settings.layout,
    target: settings.target ? { ...describeTarget(settings.target), provider: settings.target.provider } : null,
    apps,
    redirectUri: await filingOauthRedirectUri(),
  }
}

function describeTarget(target: FilingTarget): { label: string; detail: string; account: string | null } {
  if (target.provider === 'google_drive') {
    return { label: target.label, detail: `Drive folder “${target.folderName}”`, account: target.account }
  }
  if (target.provider === 'onedrive') {
    return {
      label: target.label,
      detail: target.driveId ? `SharePoint library folder “${target.folderPath}”` : `OneDrive folder “${target.folderPath}”`,
      account: target.account,
    }
  }
  return { label: target.label, detail: target.basePath, account: null }
}

/** Store (or replace) the company's OAuth application for one provider. */
export async function saveFilingApp(input: {
  tenantId: string
  provider: FilingOauthProvider
  clientId: string
  clientSecret: string
  /** Microsoft only; defaults to 'common'. */
  directory?: string
}): Promise<void> {
  const clientId = input.clientId.trim()
  const clientSecret = input.clientSecret.trim()
  if (!clientId) throw new Error('Enter the application (client) ID.')
  if (!clientSecret) throw new Error('Enter the client secret.')
  await mutateFilingSettings(input.tenantId, (current) => ({
    ...current,
    apps:
      input.provider === 'google_drive'
        ? { ...current.apps, google: { clientId, sealedClientSecret: sealSecret(clientSecret) } }
        : {
            ...current.apps,
            microsoft: {
              clientId,
              sealedClientSecret: sealSecret(clientSecret),
              tenant: assertMicrosoftDirectory(input.directory?.trim() || DEFAULT_MICROSOFT_DIRECTORY),
            },
          },
  }))
}

/** Remove an application. A destination already connected keeps working until
 *  its next token refresh, which then reports the missing application. */
export async function removeFilingApp(tenantId: string, provider: FilingOauthProvider): Promise<void> {
  await mutateFilingSettings(tenantId, (current) => {
    const apps = { ...current.apps }
    if (provider === 'google_drive') delete apps.google
    else delete apps.microsoft
    return { ...current, apps }
  })
}

/** Turn filing on or off, and choose what gets copied and how it is foldered. */
export async function saveFilingOptions(input: {
  tenantId: string
  enabled: boolean
  kinds: FilingFileKind[]
  layout: FilingLayout
}): Promise<void> {
  const kinds = FILING_FILE_KINDS.filter((kind) => input.kinds.includes(kind))
  if (input.enabled && kinds.length === 0) {
    throw new Error('Choose at least one kind of file to copy, or turn filing off.')
  }
  await mutateFilingSettings(input.tenantId, (current) => {
    if (input.enabled && !current.target) {
      throw new Error('Connect a destination before turning filing on.')
    }
    return { ...current, enabled: input.enabled, kinds, layout: input.layout }
  })
}

/** Disconnect the destination. Filing stops; nothing already filed is touched. */
export async function disconnectFilingTarget(tenantId: string): Promise<void> {
  await mutateFilingSettings(tenantId, (current) => ({ ...current, enabled: false, target: null }))
}

// --- SMB / NAS --------------------------------------------------------------

/**
 * Prove the directory is real and writable from inside this container before
 * it is saved: a probe file is written and removed. An operator who mounts the
 * share read-only, or types a path the container cannot see, learns it here
 * rather than from a silent failure days later.
 */
export async function validateFilingDirectory(basePath: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const path = basePath.trim()
  if (!path) return { ok: false, message: 'Enter the folder path as the server sees it.' }
  if (!isAbsolute(path)) return { ok: false, message: 'Use an absolute path, e.g. /mnt/company-files.' }
  const resolved = resolve(/* turbopackIgnore: true */ path)
  try {
    const info = await stat(resolved)
    if (!info.isDirectory()) return { ok: false, message: `${resolved} is not a folder.` }
  } catch {
    return {
      ok: false,
      message: `${resolved} does not exist inside the application container. Mount the share there first.`,
    }
  }
  try {
    await access(resolved, fsConstants.W_OK)
  } catch {
    return { ok: false, message: `${resolved} is not writable by the application.` }
  }
  const probe = join(/* turbopackIgnore: true */ resolved, `.bunkhouse-write-test-${randomUUID()}`)
  try {
    await writeFile(probe, 'bunkhouse filing check\n')
    await unlink(probe)
  } catch (error) {
    return { ok: false, message: `${resolved} refused a test write: ${messageOf(error)}` }
  }
  return { ok: true }
}

/** Connect a mounted folder as the filing destination, after validating it. */
export async function saveFilingDirectory(input: { tenantId: string; basePath: string; label?: string }): Promise<void> {
  const check = await validateFilingDirectory(input.basePath)
  if (!check.ok) throw new Error(check.message)
  const basePath = resolve(/* turbopackIgnore: true */ input.basePath.trim())
  await mutateFilingSettings(input.tenantId, (current) => ({
    ...current,
    enabled: true,
    target: { provider: 'smb', label: input.label?.trim() || 'Company file server', basePath },
  }))
}

// --- Authorization ----------------------------------------------------------

type OauthState = {
  tenantId: string
  provider: FilingOauthProvider
  /** The destination folder the operator asked for, chosen before consent. */
  folderName: string
  /** OneDrive only: a SharePoint document-library drive id, when given. */
  driveId: string | null
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
    throw new Error('That connection link is not valid. Start again from Settings → Filing.')
  }
  const plain = unsealSecret(sealed)
  if (plain === null) {
    throw new Error('That connection could not be verified. Start again from Settings → Filing.')
  }
  const state = JSON.parse(plain) as OauthState
  if (
    typeof state.tenantId !== 'string' ||
    typeof state.verifier !== 'string' ||
    typeof state.folderName !== 'string' ||
    typeof state.ts !== 'number' ||
    !isFilingOauthProvider(state.provider)
  ) {
    throw new Error('That connection could not be verified. Start again from Settings → Filing.')
  }
  if (Date.now() - state.ts > STATE_MAX_AGE_MS) {
    throw new Error('That connection took too long to finish. Start again from Settings → Filing.')
  }
  return state
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

type ResolvedApp = {
  provider: FilingOauthProvider
  spec: ProviderSpec
  clientId: string
  clientSecret: string
  directory: string
}

/** Unseal one provider's application for a token exchange. */
async function resolveApp(tenantId: string, provider: FilingOauthProvider): Promise<ResolvedApp> {
  const settings = await readFilingSettings(tenantId)
  const spec = PROVIDERS[provider]
  const entry = provider === 'google_drive' ? settings.apps.google : settings.apps.microsoft
  if (!entry) {
    throw new Error(`No ${spec.label} application is configured. Add one in Settings → Filing.`)
  }
  const clientSecret = unsealSecret(entry.sealedClientSecret)
  if (clientSecret === null) {
    throw new Error(
      `The ${spec.label} client secret cannot be unsealed (APPKIT_SECRET changed?). Re-enter it in Settings → Filing.`,
    )
  }
  return {
    provider,
    spec,
    clientId: entry.clientId,
    clientSecret,
    directory:
      provider === 'onedrive' && settings.apps.microsoft
        ? assertMicrosoftDirectory(settings.apps.microsoft.tenant)
        : DEFAULT_MICROSOFT_DIRECTORY,
  }
}

/** Build the provider's consent URL for the company's filing destination. */
export async function beginFilingOauth(input: {
  tenantId: string
  provider: FilingOauthProvider
  folderName: string
  driveId?: string
}): Promise<{ url: string }> {
  const folderName = input.folderName.trim() || 'Bunkhouse deliverables'
  if (/[\\/:*?"<>|]/.test(folderName)) {
    throw new Error('The folder name cannot contain \\ / : * ? " < > or |.')
  }
  const driveId = input.driveId?.trim() || null
  if (driveId && !/^[A-Za-z0-9!._~-]{1,200}$/.test(driveId)) {
    throw new Error('That does not look like a SharePoint drive ID.')
  }
  const app = db()
  const resolved = await app.withTenantContext(input.tenantId, () => resolveApp(input.tenantId, input.provider))
  const { verifier, challenge } = pkce()
  const state = sealState({
    tenantId: input.tenantId,
    provider: input.provider,
    folderName,
    driveId,
    verifier,
    nonce: randomBytes(16).toString('base64url'),
    ts: Date.now(),
  })
  const url = new URL(resolved.spec.authorizeUrl(resolved.directory))
  for (const [key, value] of Object.entries({
    client_id: resolved.clientId,
    response_type: 'code',
    redirect_uri: await filingOauthRedirectUri(),
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

/**
 * The account an identity token names. The token came straight from the
 * provider's token endpoint over a connection this process just made, so the
 * check that matters is the audience: it proves the token was minted for this
 * company's application.
 */
function accountFromIdToken(idToken: string, clientId: string): string {
  const segments = idToken.split('.')
  if (segments.length !== 3) throw new Error('The provider did not return a readable identity token.')
  let claims: Record<string, unknown>
  try {
    claims = JSON.parse(Buffer.from(segments[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    throw new Error('The provider did not return a readable identity token.')
  }
  const audience = claims.aud
  const audiences = Array.isArray(audience) ? audience : [audience]
  if (!audiences.includes(clientId)) {
    throw new Error('The sign-in was issued for a different application. Check the client ID in Settings → Filing.')
  }
  const candidate = [claims.email, claims.preferred_username, claims.upn].find(
    (value): value is string => typeof value === 'string' && value.includes('@'),
  )
  return candidate ? candidate.trim().toLowerCase() : 'the connected account'
}

export type CompleteFilingOauthResult =
  | { ok: true; provider: FilingOauthProvider; label: string; detail: string }
  | { ok: false; message: string }

/**
 * Finish the provider round-trip: validate the state, exchange the code,
 * create (or find) the destination folder, and store the sealed refresh token.
 * Returns a result rather than throwing so the callback route can send the
 * operator back to Settings with a readable explanation.
 */
export async function completeFilingOauth(input: {
  state: string
  code: string
  redirectUri: string
}): Promise<CompleteFilingOauthResult> {
  let state: OauthState
  try {
    state = openState(input.state)
  } catch (error) {
    return { ok: false, message: messageOf(error) }
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
    if (!tokens.access_token) {
      throw new Error('The provider did not return an access token, so the folder could not be prepared.')
    }
    if (!tokens.refresh_token) {
      throw new Error(
        state.provider === 'google_drive'
          ? 'Google did not issue a long-lived token, which usually means this account has already approved the application. Remove it under the account’s third-party access settings, then connect again.'
          : 'Microsoft did not issue a long-lived token. Make sure the application requests offline access and try again.',
      )
    }
    const account = tokens.id_token ? accountFromIdToken(tokens.id_token, resolved.clientId) : 'the connected account'
    const accessToken = tokens.access_token
    const sealedRefreshToken = sealSecret(tokens.refresh_token)

    // The destination folder is prepared before anything is stored: a
    // connection that cannot create its own folder is not a connection.
    let target: FilingTarget
    if (state.provider === 'google_drive') {
      const folder = await driveEnsureFolder(accessToken, state.folderName, null)
      target = {
        provider: 'google_drive',
        label: `Google Drive · ${folder.name}`,
        account,
        folderId: folder.id,
        folderName: folder.name,
        sealedRefreshToken,
      }
    } else {
      await graphEnsureFolderPath(accessToken, state.driveId, state.folderName)
      target = {
        provider: 'onedrive',
        label: `${state.driveId ? 'SharePoint' : 'OneDrive'} · ${state.folderName}`,
        account,
        driveId: state.driveId,
        folderPath: state.folderName,
        sealedRefreshToken,
      }
    }

    await mutateFilingSettings(state.tenantId, (current) => ({ ...current, enabled: true, target }))
    const described = describeTarget(target)
    return { ok: true, provider: state.provider, label: described.label, detail: described.detail }
  } catch (error) {
    return { ok: false, message: messageOf(error) }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Mint a fresh access token for the connected destination. A rotated refresh
 * token (Microsoft issues one on most refreshes and expects the previous one
 * to be dropped) is written back in its own committed transaction before the
 * access token is used for anything — losing that write would lock filing out.
 */
async function freshAccessToken(tenantId: string, target: FilingTarget): Promise<string> {
  if (target.provider === 'smb') throw new Error('A mounted folder needs no access token.')
  const provider: FilingOauthProvider = target.provider
  const refreshToken = unsealSecret(target.sealedRefreshToken)
  if (refreshToken === null) {
    throw new Error('The stored storage credential cannot be unsealed (APPKIT_SECRET changed?). Reconnect the destination.')
  }
  const app = db()
  const resolved = await app.withTenantContext(tenantId, () => resolveApp(tenantId, provider))
  const tokens = await postForm(
    resolved.spec.tokenUrl(resolved.directory),
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: resolved.clientId,
      client_secret: resolved.clientSecret,
      scope: resolved.spec.scopes,
    }),
  )
  if (!tokens.access_token) {
    throw new Error(`${resolved.spec.label} did not return an access token. Reconnect the destination.`)
  }
  if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
    const rotated = sealSecret(tokens.refresh_token)
    await mutateFilingSettings(tenantId, (current) =>
      current.target && current.target.provider === target.provider
        ? { ...current, target: { ...current.target, sealedRefreshToken: rotated } }
        : current,
    )
  }
  return tokens.access_token
}

// --- Google Drive -----------------------------------------------------------

type DriveFile = { id: string; name: string; webViewLink?: string }

/** Find (or create) a folder by name. With `drive.file` only app-created
 *  folders are visible, which is exactly the filing cabinet and nothing else. */
async function driveEnsureFolder(accessToken: string, name: string, parentId: string | null): Promise<DriveFile> {
  const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const query = [
    `name = '${escaped}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false',
    parentId ? `'${parentId}' in parents` : "'root' in parents",
  ].join(' and ')
  const url = new URL('https://www.googleapis.com/drive/v3/files')
  url.searchParams.set('q', query)
  url.searchParams.set('fields', 'files(id,name)')
  url.searchParams.set('pageSize', '1')
  url.searchParams.set('supportsAllDrives', 'true')
  url.searchParams.set('includeItemsFromAllDrives', 'true')
  const found = await apiJson<{ files?: DriveFile[] }>(url.toString(), { method: 'GET', accessToken })
  const existing = found.files?.[0]
  if (existing) return existing

  const created = await apiJson<DriveFile>(
    'https://www.googleapis.com/drive/v3/files?fields=id,name&supportsAllDrives=true',
    {
      method: 'POST',
      accessToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        ...(parentId ? { parents: [parentId] } : {}),
      }),
    },
  )
  return created
}

async function driveUpload(args: {
  accessToken: string
  parentId: string
  filename: string
  contentType: string
  bytes: Uint8Array
}): Promise<string> {
  const boundary = `bunkhouse-${randomUUID()}`
  const metadata = JSON.stringify({ name: args.filename, parents: [args.parentId] })
  const head = Buffer.from(
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\ncontent-type: ${args.contentType}\r\n\r\n`,
    'utf8',
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  const body = Buffer.concat([head, Buffer.from(args.bytes), tail])
  const uploaded = await apiJson<DriveFile>(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink',
    {
      method: 'POST',
      accessToken: args.accessToken,
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      body: new Uint8Array(body),
    },
  )
  return uploaded.webViewLink ?? `https://drive.google.com/file/d/${uploaded.id}/view`
}

// --- Microsoft Graph --------------------------------------------------------

type GraphItem = { id: string; name: string; webUrl?: string }

function graphDriveRoot(driveId: string | null): string {
  return driveId ? `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}` : 'https://graph.microsoft.com/v1.0/me/drive'
}

function graphPath(segments: string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join('/')
}

/** Create every missing folder along a path. An existing folder answers 409, which is success here. */
async function graphEnsureFolderPath(accessToken: string, driveId: string | null, path: string): Promise<void> {
  const root = graphDriveRoot(driveId)
  const segments = path.split('/').filter(Boolean)
  const walked: string[] = []
  for (const segment of segments) {
    const parent = walked.length === 0 ? `${root}/root/children` : `${root}/root:/${graphPath(walked)}:/children`
    try {
      await apiJson<GraphItem>(parent, {
        method: 'POST',
        accessToken,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: segment, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
      })
    } catch (error) {
      // Already there is the common case and not a problem; anything else is.
      const detail = messageOf(error)
      if (!/already exists|nameAlreadyExists|HTTP 409/i.test(detail)) throw error
    }
    walked.push(segment)
  }
}

async function graphUpload(args: {
  accessToken: string
  driveId: string | null
  folderPath: string
  filename: string
  contentType: string
  bytes: Uint8Array
}): Promise<string> {
  const root = graphDriveRoot(args.driveId)
  const itemPath = graphPath([...args.folderPath.split('/').filter(Boolean), args.filename])
  if (args.bytes.byteLength <= GRAPH_SIMPLE_UPLOAD_LIMIT) {
    const uploaded = await apiJson<GraphItem>(
      `${root}/root:/${itemPath}:/content?%40microsoft.graph.conflictBehavior=rename`,
      {
        method: 'PUT',
        accessToken: args.accessToken,
        headers: { 'content-type': args.contentType },
        body: new Uint8Array(args.bytes),
      },
    )
    return uploaded.webUrl ?? `${args.folderPath}/${uploaded.name}`
  }

  const session = await apiJson<{ uploadUrl?: string }>(`${root}/root:/${itemPath}:/createUploadSession`, {
    method: 'POST',
    accessToken: args.accessToken,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } }),
  })
  if (!session.uploadUrl) throw new Error('Microsoft did not return an upload session for this file.')

  const total = args.bytes.byteLength
  let offset = 0
  let final: GraphItem | null = null
  while (offset < total) {
    const end = Math.min(offset + GRAPH_CHUNK_BYTES, total)
    final = await apiJson<GraphItem>(
      session.uploadUrl,
      {
        method: 'PUT',
        accessToken: args.accessToken,
        headers: { 'content-range': `bytes ${offset}-${end - 1}/${total}` },
        body: new Uint8Array(args.bytes.slice(offset, end)),
      },
      true,
    )
    offset = end
  }
  return final?.webUrl ?? `${args.folderPath}/${args.filename}`
}

// --- Filing -----------------------------------------------------------------

/**
 * Keep a name to one path segment every destination accepts: no separators,
 * none of the characters Windows and SMB refuse, no leading dots.
 */
function safeSegment(name: string): string {
  const cleaned = name
    .replace(/[\\/]+/g, '-')
    .replace(/[<>:"|?*]+/g, '')
    .replace(/^\.+/, '')
    .trim()
  return cleaned.slice(0, 120) || 'file'
}

/** The subfolder a file belongs in, per the chosen layout. */
async function subfolderFor(tenantId: string, record: FileRecord, layout: FilingLayout): Promise<string | null> {
  if (layout === 'month') {
    const created = record.createdAt ?? new Date()
    return `${created.getUTCFullYear()}-${String(created.getUTCMonth() + 1).padStart(2, '0')}`
  }
  if (layout !== 'agent') return null
  const personId = record.personId
  if (!personId) return 'Unassigned'
  const app = db()
  const name = await app.withTenantContext(tenantId, async () => {
    const [row] = await app.db
      .select({ name: people.name })
      .from(people)
      .where(and(eq(people.tenantId, tenantId), eq(people.id, personId)))
    return row?.name ?? null
  })
  return safeSegment(name ?? 'Unassigned')
}

async function recordFiling(input: {
  tenantId: string
  fileId: string
  provider: FilingProvider
  status: 'filed' | 'failed'
  location?: string
  reason?: string
}): Promise<void> {
  const app = db()
  await app.withTenant(input.tenantId, async () => {
    await app.db.insert(fileFilings).values({
      tenantId: input.tenantId,
      fileId: input.fileId,
      provider: input.provider,
      status: input.status,
      location: input.location ?? null,
      reason: input.reason ?? null,
    })
  })
}

export type FilingOutcome = { filed: boolean; location?: string; reason?: string }

/**
 * Copy one ledgered file into the company's storage. Best-effort by contract:
 * it resolves with `filed: false` and a plain reason rather than throwing, so
 * no caller can turn a storage outage into a failed deliverable. Filing the
 * same file twice is a no-op — the log is the idempotency key — so wiring this
 * in at more than one place cannot produce duplicates.
 */
export async function fileDeliverable(args: {
  tenantId: string
  record: FileRecord
  /** The bytes, when the caller already has them; fetched from storage otherwise. */
  bytes?: Uint8Array
}): Promise<FilingOutcome> {
  const { tenantId, record } = args
  let provider: FilingProvider | null = null
  try {
    const settings = await getFilingSettings(tenantId)
    if (!settings.enabled || !settings.target) {
      return { filed: false, reason: 'Filing is not switched on for this company.' }
    }
    const target = settings.target
    provider = target.provider
    if (!settings.kinds.includes(record.kind as FilingFileKind)) {
      return { filed: false, reason: `${record.kind} files are not filed under the current settings.` }
    }

    const app = db()
    const already = await app.withTenantContext(tenantId, async () => {
      const [row] = await app.db
        .select({ location: fileFilings.location })
        .from(fileFilings)
        .where(and(eq(fileFilings.tenantId, tenantId), eq(fileFilings.fileId, record.id), eq(fileFilings.status, 'filed')))
        .orderBy(desc(fileFilings.createdAt))
        .limit(1)
      return row ?? null
    })
    if (already) return { filed: true, ...(already.location ? { location: already.location } : {}) }

    const bytes = args.bytes ?? (await getFileBytes(record))
    const subfolder = await subfolderFor(tenantId, record, settings.layout)
    const filename = safeSegment(record.filename)
    const location = await uploadToTarget({ tenantId, target, subfolder, filename, record, bytes })
    await recordFiling({ tenantId, fileId: record.id, provider, status: 'filed', location })
    return { filed: true, location }
  } catch (error) {
    const reason = messageOf(error)
    if (provider) {
      // The log is the operator's only window onto a failed copy, so a failure
      // to write it must not take the reason down with it.
      try {
        await recordFiling({ tenantId, fileId: record.id, provider, status: 'failed', reason })
      } catch {
        /* the caller still gets the reason below */
      }
    }
    return { filed: false, reason }
  }
}

async function uploadToTarget(args: {
  tenantId: string
  target: FilingTarget
  subfolder: string | null
  filename: string
  record: FileRecord
  bytes: Uint8Array
}): Promise<string> {
  const { target, subfolder, filename, record, bytes } = args
  if (target.provider === 'smb') {
    const directory = subfolder ? join(/* turbopackIgnore: true */ target.basePath, safeSegment(subfolder)) : target.basePath
    await mkdir(directory, { recursive: true })
    const destination = join(/* turbopackIgnore: true */ directory, filename)
    await writeFile(destination, bytes)
    return destination
  }

  const accessToken = await freshAccessToken(args.tenantId, target)
  if (target.provider === 'google_drive') {
    const parent = subfolder
      ? (await driveEnsureFolder(accessToken, safeSegment(subfolder), target.folderId)).id
      : target.folderId
    return driveUpload({ accessToken, parentId: parent, filename, contentType: record.contentType, bytes })
  }

  const folderPath = subfolder ? `${target.folderPath}/${safeSegment(subfolder)}` : target.folderPath
  await graphEnsureFolderPath(accessToken, target.driveId, folderPath)
  return graphUpload({
    accessToken,
    driveId: target.driveId,
    folderPath,
    filename,
    contentType: record.contentType,
    bytes,
  })
}

/** What Settings → Filing shows: the recent attempts, successes and failures alike. */
export type FilingLogEntry = {
  id: string
  fileId: string
  filename: string | null
  provider: FilingProvider
  status: 'filed' | 'failed'
  location: string | null
  reason: string | null
  createdAt: Date
}

export async function listRecentFilings(tenantId: string, limit = 25): Promise<FilingLogEntry[]> {
  const app = db()
  return app.withTenantContext(tenantId, () =>
    app.db
      .select({
        id: fileFilings.id,
        fileId: fileFilings.fileId,
        filename: files.filename,
        provider: fileFilings.provider,
        status: fileFilings.status,
        location: fileFilings.location,
        reason: fileFilings.reason,
        createdAt: fileFilings.createdAt,
      })
      .from(fileFilings)
      .leftJoin(files, eq(files.id, fileFilings.fileId))
      .where(eq(fileFilings.tenantId, tenantId))
      .orderBy(desc(fileFilings.createdAt))
      .limit(limit),
  )
}
