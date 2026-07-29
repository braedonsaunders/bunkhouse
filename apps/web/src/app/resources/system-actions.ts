'use server'

import { revalidatePath } from 'next/cache'
import { sealSecret } from '@appkit/crypto'
import { connectMcpServers } from '@bunkhouse/runtime'
import { listMcpIntegrations, saveMcpIntegrations } from '../../lib/mcp-integrations'
import { beginMcpOauth } from '../../lib/mcp-oauth'
import { resolveTenantId } from '../../lib/tenant'
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
  'computer_use',
  'shell',
  'phone_call',
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
    })
    await saveMcpIntegrations(tenantId, entries)
  })
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

export async function removeMcpIntegrationAction(formData: FormData): Promise<void> {
  const slug = String(formData.get('slug') ?? '')
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    const entries = (await listMcpIntegrations(tenantId)).filter((entry) => entry.slug !== slug)
    await saveMcpIntegrations(tenantId, entries)
  })
  revalidatePath('/resources')
}
