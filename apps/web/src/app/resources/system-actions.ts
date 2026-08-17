'use server'

import { revalidatePath } from 'next/cache'
import { sealSecret, unsealSecret } from '@braedonsaunders/appkit-crypto'
import { connectMcpServers } from '@bunkhouse/runtime'
import {
  forgetMcpHealth,
  listMcpIntegrations,
  recordMcpHealth,
  saveMcpIntegrations,
} from '../../lib/mcp-integrations'
import { probeSystem } from '../../lib/mcp-health'
import { beginMcpOauth, forgetMintedTokens, verifyM2mGrant } from '../../lib/mcp-oauth'
import { resolveTenantId as resolveTenant } from '../../lib/tenant'
const resolveTenantId = () => resolveTenant('resources.manage')
import { parseAssignment } from '../../lib/assignment'
import { db } from '../../db/client'

/**
 * Connecting the outside systems agents work in, over MCP. The stored shape is
 * unchanged from when these connections lived under Settings — the settings key
 * stays `integrations.mcp` so no tenant loses a connection over a rename.
 */

/** The action categories the autonomy dial governs — a system runs entirely
 *  under the one chosen for it. */
const ACTION_CATEGORIES = [
  'external_email',
  'internal_email',
  'record_write',
  'money_adjacent',
  'file_write',
  'phone_call',
  'sandbox',
  'desktop',
  'shared_folder',
  'background_job',
]

/** Add or replace a system connection; it is probed before saving. */
export async function saveMcpIntegrationAction(input: {
  slug: string
  label: string
  url: string
  /** One header per line, `Name: value`. Sealed at rest, never echoed back. */
  headersText: string
  category: string
}): Promise<{ ok: true; toolCount: number } | { ok: false; message: string }> {
  const slug = input.slug.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  if (!slug) return { ok: false, message: 'Give the system a short slug.' }
  if (!input.label.trim()) return { ok: false, message: 'Give the system a name.' }
  let url: URL
  try {
    url = new URL(input.url.trim())
  } catch {
    return { ok: false, message: 'That URL is not valid.' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: 'The server URL must be http(s).' }
  }
  if (!ACTION_CATEGORIES.includes(input.category)) {
    return { ok: false, message: 'Pick the action category it is governed under.' }
  }

  const headers: Record<string, string> = {}
  for (const line of input.headersText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const colon = trimmed.indexOf(':')
    if (colon <= 0) return { ok: false, message: `Header line "${trimmed.slice(0, 40)}" is not "Name: value".` }
    headers[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim()
  }

  // Probe the connection so a typo'd URL or bad token fails here, not mid-call.
  let toolCount = 0
  try {
    const probe = await connectMcpServers([
      {
        slug,
        url: url.toString(),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
    ])
    toolCount = probe.abilities.length
    await probe.close()
  } catch (error) {
    return {
      ok: false,
      message: `Could not connect: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    const all = await listMcpIntegrations(tenantId)
    const previous = all.find((entry) => entry.slug === slug)
    const entries = all.filter((entry) => entry.slug !== slug)
    // Blank headers on an edit mean "keep what is sealed", not "drop it".
    const sealedHeaders =
      Object.keys(headers).length > 0 ? sealSecret(JSON.stringify(headers)) : previous?.sealedHeaders
    entries.push({
      slug,
      label: input.label.trim(),
      url: url.toString(),
      ...(sealedHeaders ? { sealedHeaders } : {}),
      category: input.category,
      // A reconnect keeps who the system was granted to; a first connection
      // starts in every agent's toolbox, and Applies to narrows it from there.
      assignment: previous?.assignment ?? { everyone: true },
    })
    await saveMcpIntegrations(tenantId, entries)
    // It answered a moment ago, on the way in — say so, rather than leaving the
    // row unjudged until the next housekeeping pass.
    await recordMcpHealth(tenantId, slug, { status: 'ok', checkedAt: Date.now(), toolCount })
  })
  // Switching a system to a pasted token drops its certificate; any token
  // minted under that certificate has to go with it.
  forgetMintedTokens(tenantId, slug)
  revalidatePath('/resources')
  return { ok: true, toolCount }
}

/**
 * Start an OAuth sign-in for a connection. Returns the provider's consent URL
 * for the browser to follow; the connection is only saved once the provider
 * redirects back and the grant is proved against the server.
 */
export async function beginMcpOauthAction(input: {
  slug: string
  label: string
  url: string
  category: string
  /** Only for servers that do not offer automatic client registration. */
  clientId?: string
  clientSecret?: string
}): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const slug = input.slug.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  if (!slug) return { ok: false, message: 'Give the system a short slug.' }
  if (!input.label.trim()) return { ok: false, message: 'Give the system a name.' }
  let url: URL
  try {
    url = new URL(input.url.trim())
  } catch {
    return { ok: false, message: 'That URL is not valid.' }
  }
  if (url.protocol !== 'https:') {
    return { ok: false, message: 'OAuth sign-in requires an https server URL.' }
  }
  if (!ACTION_CATEGORIES.includes(input.category)) {
    return { ok: false, message: 'Pick the action category it is governed under.' }
  }
  try {
    const tenantId = await resolveTenantId()
    const { url: consentUrl } = await beginMcpOauth({
      tenantId,
      slug,
      label: input.label.trim(),
      url: url.toString(),
      category: input.category,
      ...(input.clientId?.trim() ? { clientId: input.clientId.trim() } : {}),
      ...(input.clientSecret?.trim() ? { clientSecret: input.clientSecret.trim() } : {}),
    })
    return { ok: true, url: consentUrl }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Connect a system the company authenticates to as itself, with a certificate
 * the provider holds — no operator sign-in, and no refresh token to lapse.
 *
 * Nothing is saved until a token has actually been minted and the server has
 * answered over it. The three ways this fails all read alike at the provider
 * (`invalid_grant` for a wrong algorithm, an unmapped certificate, or a role
 * that cannot reach the resource), so proving it here is the difference
 * between an operator fixing it now and an agent discovering it at 8am.
 */
export async function saveMcpM2mAction(input: {
  slug: string
  label: string
  url: string
  category: string
  clientId: string
  /** PEM private key. Blank on an edit means "keep the sealed one". */
  privateKey: string
  algorithm: string
  /** The provider's name for the certificate — NetSuite's Certificate ID. */
  keyId?: string
  scope?: string
}): Promise<{ ok: true; toolCount: number } | { ok: false; message: string }> {
  const slug = input.slug.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  if (!slug) return { ok: false, message: 'Give the system a short slug.' }
  if (!input.label.trim()) return { ok: false, message: 'Give the system a name.' }
  let url: URL
  try {
    url = new URL(input.url.trim())
  } catch {
    return { ok: false, message: 'That URL is not valid.' }
  }
  if (url.protocol !== 'https:') {
    return { ok: false, message: 'A certificate connection requires an https server URL.' }
  }
  if (!ACTION_CATEGORIES.includes(input.category)) {
    return { ok: false, message: 'Pick the action category it is governed under.' }
  }
  if (!input.clientId.trim()) {
    return { ok: false, message: 'Enter the Client ID of the application you registered with the provider.' }
  }

  const tenantId = await resolveTenantId()
  const app = db()
  const previous = await app.withTenantContext(tenantId, async () =>
    (await listMcpIntegrations(tenantId)).find((entry) => entry.slug === slug),
  )

  // A blank key on an edit keeps what is sealed, exactly like blank headers do.
  let privateKey = input.privateKey.trim()
  if (!privateKey) {
    const sealed = previous?.m2m?.sealedPrivateKey
    const kept = sealed ? unsealSecret(sealed) : null
    if (!kept) return { ok: false, message: 'Paste the private key for this connection.' }
    privateKey = kept
  }
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
    return { ok: false, message: 'That does not look like a PEM private key — paste the whole file, BEGIN and END lines included.' }
  }

  let verified: Awaited<ReturnType<typeof verifyM2mGrant>>
  try {
    verified = await verifyM2mGrant({
      url: url.toString(),
      clientId: input.clientId.trim(),
      privateKey,
      algorithm: input.algorithm,
      ...(input.keyId?.trim() ? { keyId: input.keyId.trim() } : {}),
      ...(input.scope?.trim() ? { scope: input.scope.trim() } : {}),
    })
  } catch (error) {
    return { ok: false, message: `Could not mint a token: ${error instanceof Error ? error.message : String(error)}` }
  }

  let toolCount = 0
  try {
    const probe = await connectMcpServers([{ slug, url: url.toString(), headers: verified.headers }])
    toolCount = probe.abilities.length
    await probe.close()
  } catch (error) {
    return {
      ok: false,
      message: `Signed in, but the server did not answer: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  await app.withTenant(tenantId, async () => {
    const entries = (await listMcpIntegrations(tenantId)).filter((entry) => entry.slug !== slug)
    entries.push({
      slug,
      label: input.label.trim(),
      url: url.toString(),
      m2m: { ...verified.grant, sealedPrivateKey: sealSecret(privateKey) },
      category: input.category,
      assignment: previous?.assignment ?? { everyone: true },
    })
    await saveMcpIntegrations(tenantId, entries)
    await recordMcpHealth(tenantId, slug, { status: 'ok', checkedAt: Date.now(), toolCount })
  })
  // The credential may have changed under the same slug; a token minted with
  // the old one must not outlive it.
  forgetMintedTokens(tenantId, slug)
  revalidatePath('/resources')
  return { ok: true, toolCount }
}

export type SystemTool = { name: string; description: string }

export type SystemToolsResult =
  | { ok: true; tools: SystemTool[] }
  | { ok: false; message: string }

/**
 * What a connected system exposes, read live from the server rather than from
 * anything recorded at connect time. A vendor adds and retires tools without
 * telling anyone, so a stored list would drift into fiction — and an operator
 * asking what their agents can do is exactly the moment to find out that a
 * connection has stopped answering.
 */
export async function listSystemToolsAction(slug: string): Promise<SystemToolsResult> {
  const tenantId = await resolveTenantId()
  const app = db()
  // Inside a tenant scope: `tenant_settings` is RLS-enforced, so an unscoped
  // read returns nothing and a perfectly healthy connection reads as deleted.
  const entry = await app.withTenantContext(tenantId, async () =>
    (await listMcpIntegrations(tenantId)).find((candidate) => candidate.slug === slug),
  )
  if (!entry) return { ok: false, message: 'That system is no longer connected.' }

  // The same probe the housekeeping pass runs, so opening this tab updates what
  // the list says rather than telling the operator something the row contradicts.
  const probe = await probeSystem(tenantId, entry)
  revalidatePath('/resources')
  return probe.ok ? { ok: true, tools: probe.tools } : { ok: false, message: probe.message }
}

/** Rebind which agents carry this system in their toolbox. */
export async function setSystemAssignmentAction(formData: FormData): Promise<void> {
  const slug = String(formData.get('slug') ?? '')
  if (!slug) throw new Error('slug is required.')
  const assignment = parseAssignment(formData)
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    const entries = await listMcpIntegrations(tenantId)
    if (!entries.some((entry) => entry.slug === slug)) throw new Error('That system is no longer connected.')
    await saveMcpIntegrations(
      tenantId,
      entries.map((entry) => (entry.slug === slug ? { ...entry, assignment } : entry)),
    )
  })
  revalidatePath('/resources')
  revalidatePath('/roles')
}

export async function removeMcpIntegrationAction(formData: FormData): Promise<void> {
  const slug = String(formData.get('slug') ?? '')
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    const entries = (await listMcpIntegrations(tenantId)).filter((entry) => entry.slug !== slug)
    await saveMcpIntegrations(tenantId, entries)
    await forgetMcpHealth(tenantId, slug)
  })
  forgetMintedTokens(tenantId, slug)
  revalidatePath('/resources')
}
