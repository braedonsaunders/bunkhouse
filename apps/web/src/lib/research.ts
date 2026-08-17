import 'server-only'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { and, eq } from 'drizzle-orm'
import { sealSecret, unsealSecret, type SealedSecret } from '@braedonsaunders/appkit-crypto'
import { tenantSettings } from '../db/schema'
import { db } from '../db/client'

/**
 * Web research for agents: search the internet, read a page. The search
 * provider is tenant configuration — an operator adds a Brave or Tavily key in
 * Settings → Research and every agent searches on it. With no provider
 * configured, search falls back to DuckDuckGo's keyless HTML endpoint, so
 * research works out of the box and gets better with a key.
 */

export const RESEARCH_SETTINGS_KEY = 'research.settings'

export type SearchProvider = 'brave' | 'tavily'

export type ResearchSettings = {
  provider?: { kind: SearchProvider; sealedApiKey: SealedSecret }
}

export type SearchResult = { title: string; url: string; snippet: string }

async function readSettings(tenantId: string): Promise<ResearchSettings> {
  const app = db()
  const [row] = await app.db
    .select({ value: tenantSettings.value })
    .from(tenantSettings)
    .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, RESEARCH_SETTINGS_KEY)))
  return (row?.value as ResearchSettings | undefined) ?? {}
}

async function writeSettings(tenantId: string, value: ResearchSettings): Promise<void> {
  const app = db()
  await app.db
    .insert(tenantSettings)
    .values({ tenantId, key: RESEARCH_SETTINGS_KEY, value })
    .onConflictDoUpdate({
      target: [tenantSettings.tenantId, tenantSettings.key],
      set: { value, updatedAt: new Date() },
    })
}

/** Sealed state for the settings page — never the key itself. */
export async function getResearchSettings(tenantId: string): Promise<{ provider: SearchProvider | null }> {
  const app = db()
  const settings = await app.withTenantContext(tenantId, () => readSettings(tenantId))
  return { provider: settings.provider?.kind ?? null }
}

/** Verify the key against the provider's live API, then seal and store it. */
export async function setSearchProvider(args: {
  tenantId: string
  provider: SearchProvider
  apiKey: string
}): Promise<void> {
  const probe =
    args.provider === 'brave'
      ? await fetch('https://api.search.brave.com/res/v1/web/search?q=test&count=1', {
          headers: { 'X-Subscription-Token': args.apiKey, Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        })
      : await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { Authorization: `Bearer ${args.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'test', max_results: 1 }),
          signal: AbortSignal.timeout(10_000),
        })
  if (!probe.ok) {
    throw new Error(
      probe.status === 401 || probe.status === 403
        ? 'That key was not accepted by the provider.'
        : `The provider returned ${probe.status} while verifying the key.`,
    )
  }
  const app = db()
  await app.withTenant(args.tenantId, () =>
    writeSettings(args.tenantId, {
      provider: { kind: args.provider, sealedApiKey: sealSecret(args.apiKey) },
    }),
  )
}

export async function removeSearchProvider(tenantId: string): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, () => writeSettings(tenantId, {}))
}

const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))

/** Search the web on the tenant's provider, or DuckDuckGo without one. */
export async function webSearch(tenantId: string, query: string, limit = 6): Promise<SearchResult[]> {
  const app = db()
  const settings = await app.withTenantContext(tenantId, () => readSettings(tenantId))
  const provider = settings.provider

  if (provider?.kind === 'brave') {
    const key = unsealSecret(provider.sealedApiKey)
    if (!key) throw new Error('The search key could not be unsealed — re-add it in Settings → Research.')
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
      { headers: { 'X-Subscription-Token': key, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
    )
    if (!res.ok) throw new Error(`Brave search failed (${res.status}).`)
    const data = (await res.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } }
    return (data.web?.results ?? []).slice(0, limit).map((r) => ({
      title: decodeEntities(r.title.replace(/<[^>]+>/g, '')),
      url: r.url,
      snippet: decodeEntities((r.description ?? '').replace(/<[^>]+>/g, '')),
    }))
  }

  if (provider?.kind === 'tavily') {
    const key = unsealSecret(provider.sealedApiKey)
    if (!key) throw new Error('The search key could not be unsealed — re-add it in Settings → Research.')
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, max_results: limit }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`Tavily search failed (${res.status}).`)
    const data = (await res.json()) as { results?: { title: string; url: string; content?: string }[] }
    return (data.results ?? []).slice(0, limit).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: (r.content ?? '').slice(0, 300),
    }))
  }

  // Keyless fallback: DuckDuckGo's HTML endpoint. Fragile by nature (it is a
  // page, not an API) — parsed defensively, and a configured provider wins.
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BunkhouseAgent/1.0)' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Search failed (${res.status}).`)
  const html = await res.text()
  const results: SearchResult[] = []
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  const snippets: string[] = []
  for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) {
    snippets.push(decodeEntities(m[1]!.replace(/<[^>]+>/g, '')).trim())
  }
  let index = 0
  for (let m = linkRe.exec(html); m && results.length < limit; m = linkRe.exec(html), index += 1) {
    let url = m[1]!
    // DDG wraps result urls: //duckduckgo.com/l/?uddg=<encoded>&…
    const wrapped = /[?&]uddg=([^&]+)/.exec(url)
    if (wrapped) url = decodeURIComponent(wrapped[1]!)
    if (url.startsWith('//')) url = `https:${url}`
    results.push({
      title: decodeEntities(m[2]!.replace(/<[^>]+>/g, '')).trim(),
      url,
      snippet: snippets[index] ?? '',
    })
  }
  return results
}

// ---------------------------------------------------------------------------
// Page reading — SSRF-guarded fetch + readable-text extraction
// ---------------------------------------------------------------------------

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number]
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a >= 224
    )
  }
  const lower = address.toLowerCase()
  return (
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe80') ||
    lower.startsWith('::ffff:127.') ||
    lower.startsWith('::ffff:10.') ||
    lower.startsWith('::ffff:192.168.')
  )
}

/**
 * The agent's fetch runs from inside the network, so every hop of a page load
 * is checked against private address space — an agent must not be talkable
 * into reading the metadata service or an internal admin panel. Shared with
 * the browser-use abilities, which apply it to every top-level navigation.
 */
export async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http(s) pages can be read.')
  }
  const host = url.hostname
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('That address is not reachable from here.')
    return
  }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('That address is not reachable from here.')
  }
  // A resolver that never answers used to hang the whole run: no result, no
  // error, an agent saying "almost there" for five minutes. DNS gets a
  // deadline like everything else that leaves this process.
  const resolved = await Promise.race([
    lookup(host, { all: true }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Looking up ${host} took too long.`)), 5_000).unref?.(),
    ),
  ])
  if (resolved.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('That address is not reachable from here.')
  }
}

export type PageContent = { url: string; title: string; text: string; truncated: boolean }

/** Fetch a public web page and reduce it to readable text. */
export async function readWebpage(url: string, maxChars = 8000): Promise<PageContent> {
  let current = new URL(url)
  let response: Response | null = null
  // Redirects are followed by hand so every hop is validated.
  for (let hop = 0; hop < 5; hop += 1) {
    await assertPublicHost(current)
    response = await fetch(current, {
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BunkhouseAgent/1.0)', Accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(20_000),
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) break
      current = new URL(location, current)
      continue
    }
    break
  }
  if (!response || !response.ok) throw new Error(`The page returned ${response?.status ?? 'no response'}.`)

  const type = response.headers.get('content-type') ?? ''
  const raw = await response.text()
  if (!type.includes('html')) {
    const text = raw.slice(0, maxChars)
    return { url: current.toString(), title: current.hostname, text, truncated: raw.length > maxChars }
  }

  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.trim() ?? current.hostname)
  // Prefer the article/main region when the page marks one.
  const region =
    /<article[^>]*>([\s\S]*?)<\/article>/i.exec(raw)?.[1] ??
    /<main[^>]*>([\s\S]*?)<\/main>/i.exec(raw)?.[1] ??
    /<body[^>]*>([\s\S]*?)<\/body>/i.exec(raw)?.[1] ??
    raw
  const text = decodeEntities(
    region
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(nav|header|footer|aside|form|svg)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return {
    url: current.toString(),
    title,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
  }
}
