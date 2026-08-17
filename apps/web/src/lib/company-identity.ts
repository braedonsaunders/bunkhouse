import 'server-only'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { generateText } from 'ai'
import { getModel } from '@braedonsaunders/appkit-ai'
import type { CompanyProfile } from '@bunkhouse/runtime'
import { COMPANY_IDENTITY_KEY, tenantSettings, type CompanyIdentitySettings } from '../db/schema'
import { db } from '../db/client'
import { listAiProviders, resolveProviderAiConfig } from './ai'
import { assertPublicHost } from './research'

/**
 * The company record every agent stands on. Agents are staff, not chatbots:
 * they need to know whose letterhead they write under, what the business
 * actually does, who it serves, and how it talks. That is operator-owned
 * configuration, so it lives in tenant settings and is editable by hand.
 *
 * Drafting it from the company website is a convenience on top, never a
 * source of truth: the capture reads public pages, asks the tenant's own
 * model to summarise them, and hands the operator a draft to correct. Nothing
 * is stored until they save it.
 */

/** The identity with every field resolved — what callers read. */
export type CompanyIdentity = {
  name: string
  legalName: string
  tagline: string
  websiteUrl: string
  industry: string
  description: string
  /** The company's own email domains, bare and lowercased. */
  internalDomains: string[]
  services: string[]
  serviceArea: string
  customers: string[]
  differentiators: string[]
  values: string[]
  brandVoice: string
  hours: string
  contact: { phone: string; email: string; address: string }
  socialLinks: Record<string, string>
  notes: string
  capture: CompanyIdentitySettings['capture'] | null
}

const EMPTY: CompanyIdentity = {
  name: '',
  legalName: '',
  tagline: '',
  websiteUrl: '',
  industry: '',
  description: '',
  internalDomains: [],
  services: [],
  serviceArea: '',
  customers: [],
  differentiators: [],
  values: [],
  brandVoice: '',
  hours: '',
  contact: { phone: '', email: '', address: '' },
  socialLinks: {},
  notes: '',
  capture: null,
}

function normalize(stored: CompanyIdentitySettings | undefined): CompanyIdentity {
  if (!stored) return EMPTY
  return {
    name: stored.name ?? '',
    legalName: stored.legalName ?? '',
    tagline: stored.tagline ?? '',
    websiteUrl: stored.websiteUrl ?? '',
    industry: stored.industry ?? '',
    description: stored.description ?? '',
    internalDomains: stored.internalDomains ?? [],
    services: stored.services ?? [],
    serviceArea: stored.serviceArea ?? '',
    customers: stored.customers ?? [],
    differentiators: stored.differentiators ?? [],
    values: stored.values ?? [],
    brandVoice: stored.brandVoice ?? '',
    hours: stored.hours ?? '',
    contact: {
      phone: stored.contact?.phone ?? '',
      email: stored.contact?.email ?? '',
      address: stored.contact?.address ?? '',
    },
    socialLinks: stored.socialLinks ?? {},
    notes: stored.notes ?? '',
    capture: stored.capture ?? null,
  }
}

export async function getCompanyIdentity(tenantId: string): Promise<CompanyIdentity> {
  const app = db()
  const [row] = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ value: tenantSettings.value })
      .from(tenantSettings)
      .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, COMPANY_IDENTITY_KEY))),
  )
  return normalize(row?.value as CompanyIdentitySettings | undefined)
}

export async function saveCompanyIdentity(tenantId: string, value: CompanyIdentitySettings): Promise<void> {
  const app = db()
  await app.db
    .insert(tenantSettings)
    .values({ tenantId, key: COMPANY_IDENTITY_KEY, value })
    .onConflictDoUpdate({
      target: [tenantSettings.tenantId, tenantSettings.key],
      set: { value, updatedAt: new Date() },
    })
}

/**
 * What agents call the company. Falls back to a neutral phrase so a run never
 * addresses anyone as "undefined" before an operator fills this in.
 */
export function companyDisplayName(identity: CompanyIdentity): string {
  return identity.name.trim() || 'the company'
}

/**
 * The identity as prompt assembly takes it — one derivation for every surface
 * that builds a system prompt (mail runs, voice calls, meetings), so an agent
 * works at the same company on every channel. Empty fields are dropped here,
 * once, rather than by each caller.
 */
export function companyPromptProfile(identity: CompanyIdentity): Omit<CompanyProfile, 'directory'> {
  return {
    name: companyDisplayName(identity),
    ...(identity.description ? { description: identity.description } : {}),
    identity: {
      ...(identity.legalName ? { legalName: identity.legalName } : {}),
      ...(identity.tagline ? { tagline: identity.tagline } : {}),
      ...(identity.industry ? { industry: identity.industry } : {}),
      ...(identity.websiteUrl ? { websiteUrl: identity.websiteUrl } : {}),
      ...(identity.services.length > 0 ? { services: identity.services } : {}),
      ...(identity.serviceArea ? { serviceArea: identity.serviceArea } : {}),
      ...(identity.customers.length > 0 ? { customers: identity.customers } : {}),
      ...(identity.differentiators.length > 0 ? { differentiators: identity.differentiators } : {}),
      ...(identity.values.length > 0 ? { values: identity.values } : {}),
      ...(identity.brandVoice ? { brandVoice: identity.brandVoice } : {}),
      ...(identity.hours ? { hours: identity.hours } : {}),
      ...(identity.contact.phone || identity.contact.email || identity.contact.address
        ? {
            contact: {
              ...(identity.contact.phone ? { phone: identity.contact.phone } : {}),
              ...(identity.contact.email ? { email: identity.contact.email } : {}),
              ...(identity.contact.address ? { address: identity.contact.address } : {}),
            },
          }
        : {}),
      ...(identity.notes ? { notes: identity.notes } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// Website capture — read the public site, draft the identity from it
// ---------------------------------------------------------------------------

/** Pages worth trying by name before falling back to discovered links. */
const PRIORITY_PATHS = [
  '/',
  '/about',
  '/about-us',
  '/who-we-are',
  '/services',
  '/what-we-do',
  '/capabilities',
  '/solutions',
  '/products',
  '/industries',
  '/contact',
  '/contact-us',
]

/** Link text/href fragments that make a discovered page worth reading. */
const INTERESTING = /about|service|what-we-do|capabilit|solution|product|industr|contact|team|mission|value/i

const SKIP_EXTENSIONS =
  /\.(pdf|jpe?g|png|gif|svg|webp|css|js|zip|docx?|xlsx?|pptx?|mp[34]|avi|mov|ico|woff2?|ttf|eot)$/i

const MAX_PAGES = 8
const MAX_PAGE_CHARS = 9_000
const MAX_PROMPT_CHARS = 24_000

function stripWww(hostname: string): string {
  return hostname.replace(/^www\./i, '').toLowerCase()
}

/** Origin + path, no hash/query — the identity of a page for dedupe. */
function canonical(url: URL): string {
  return `${url.origin}${url.pathname.replace(/\/+$/, '') || '/'}`
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
}

const dedupe = (values: string[]): string[] => {
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = value.toLowerCase()
    if (seen.has(key) || !value) return false
    seen.add(key)
    return true
  })
}

/**
 * Fetch one public page as HTML. Every hop is checked against private address
 * space by the same guard the agents' own page reading uses — a capture must
 * not be talked into reading an internal admin panel or a metadata service.
 */
async function fetchHtml(target: URL): Promise<{ html: string; url: URL } | null> {
  let current = target
  for (let hop = 0; hop < 5; hop += 1) {
    await assertPublicHost(current)
    const response = await fetch(current, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BunkhouseIdentityCapture/1.0)',
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) return null
      current = new URL(location, current)
      continue
    }
    if (!response.ok) return null
    if (!(response.headers.get('content-type') ?? '').includes('html')) return null
    return { html: await response.text(), url: current }
  }
  return null
}

/** Readable lines from a page: headings, prose, list items, contact links. */
function extractLines(html: string): string {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')

  const lines: string[] = []
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]
  if (title) lines.push(decodeEntities(title).replace(/\s+/g, ' ').trim())
  for (const pattern of [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
  ]) {
    const found = pattern.exec(body)?.[1]
    if (found) lines.push(decodeEntities(found).trim())
  }

  const blocks = /<(h[1-4]|p|li|dt|dd|address|figcaption|blockquote)[^>]*>([\s\S]*?)<\/\1>/gi
  for (let match = blocks.exec(body); match; match = blocks.exec(body)) {
    const text = decodeEntities(match[2]!.replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim()
    if (text.length >= 3 && /[a-z]/i.test(text)) lines.push(text)
  }

  // Contact and social details live in hrefs, not in prose.
  const anchors = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  for (let match = anchors.exec(body); match; match = anchors.exec(body)) {
    const href = match[1]!
    const label = decodeEntities(match[2]!.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
    if (/^mailto:/i.test(href)) lines.push(`Email: ${href.replace(/^mailto:/i, '').trim()}`)
    else if (/^tel:/i.test(href)) lines.push(`Phone: ${href.replace(/^tel:/i, '').trim()}`)
    else if (/linkedin\.com|facebook\.com|instagram\.com|youtube\.com|x\.com|twitter\.com/i.test(href)) {
      lines.push(`Social: ${label || 'profile'} -> ${href}`)
    }
  }

  return dedupe(lines).join('\n').slice(0, MAX_PAGE_CHARS)
}

/** Same-site links worth queueing, most promising first. */
function discoverLinks(html: string, base: URL): string[] {
  const host = stripWww(base.hostname)
  const found: { url: string; score: number }[] = []
  const anchors = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  for (let match = anchors.exec(html); match; match = anchors.exec(html)) {
    let parsed: URL
    try {
      parsed = new URL(match[1]!, base)
    } catch {
      continue
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
    if (stripWww(parsed.hostname) !== host) continue
    if (SKIP_EXTENSIONS.test(parsed.pathname)) continue
    const label = match[2]!.replace(/<[^>]+>/g, ' ')
    const score = (INTERESTING.test(parsed.pathname) ? 2 : 0) + (INTERESTING.test(label) ? 1 : 0)
    if (score === 0) continue
    found.push({ url: canonical(parsed), score })
  }
  return dedupe(found.sort((a, b) => b.score - a.score).map((entry) => entry.url))
}

type CrawledSite = { pages: { url: string; text: string }[]; content: string }

/** Read the site: named pages first, then the most promising links found. */
async function crawlSite(root: URL): Promise<CrawledSite> {
  const visited = new Set<string>()
  const pages: { url: string; text: string }[] = []
  const queue = dedupe([canonical(root), ...PRIORITY_PATHS.map((path) => `${root.origin}${path}`)])

  for (let index = 0; index < queue.length && pages.length < MAX_PAGES; index += 1) {
    const next = queue[index]!
    if (visited.has(next)) continue
    visited.add(next)

    let page: { html: string; url: URL } | null = null
    try {
      page = await fetchHtml(new URL(next))
    } catch {
      continue
    }
    if (!page) continue
    visited.add(canonical(page.url))

    const text = extractLines(page.html)
    if (text.length > 80) pages.push({ url: page.url.toString(), text })

    // Only the landing page contributes new links, so one sprawling site
    // cannot walk the crawl budget away from the pages that matter.
    if (pages.length === 1) {
      for (const link of discoverLinks(page.html, page.url)) {
        if (!visited.has(link) && !queue.includes(link)) queue.push(link)
      }
    }
  }

  const content = pages
    .map((page) => `--- ${page.url} ---\n${page.text}`)
    .join('\n\n')
    .slice(0, MAX_PROMPT_CHARS)
  return { pages, content }
}

const draftSchema = z.object({
  name: z.string().default(''),
  legalName: z.string().default(''),
  tagline: z.string().default(''),
  industry: z.string().default(''),
  description: z.string().default(''),
  services: z.array(z.string()).default([]),
  serviceArea: z.string().default(''),
  customers: z.array(z.string()).default([]),
  differentiators: z.array(z.string()).default([]),
  values: z.array(z.string()).default([]),
  brandVoice: z.string().default(''),
  hours: z.string().default(''),
  contact: z
    .object({ phone: z.string().default(''), email: z.string().default(''), address: z.string().default('') })
    .default({ phone: '', email: '', address: '' }),
  socialLinks: z.record(z.string(), z.string()).default({}),
})

/** Models are asked for bare JSON; fenced or prefixed replies still parse. */
function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('The model did not return a JSON object.')
  return JSON.parse(cleaned.slice(start, end + 1))
}

const CAPTURE_SYSTEM = `You are drafting a company profile for the staff who work there, from that company's own website.

Return ONLY a JSON object, no prose, with these keys:
{
  "name": "trading name the company calls itself",
  "legalName": "registered entity name if the site states one, else empty",
  "tagline": "slogan or positioning line, else empty",
  "industry": "the sector in a few words",
  "description": "2-4 sentences on what the business actually does",
  "services": ["services or products offered"],
  "serviceArea": "where it works, e.g. a region or 'nationwide', else empty",
  "customers": ["who it serves — segments, industries, customer types"],
  "differentiators": ["claims the site makes about what sets it apart"],
  "values": ["stated values or principles"],
  "brandVoice": "one sentence on how the company writes and speaks",
  "hours": "business hours in plain language if stated, else empty",
  "contact": { "phone": "", "email": "", "address": "" },
  "socialLinks": { "linkedin": "url", "facebook": "url" }
}

Rules:
- Use only what the pages actually say. Never invent, infer a plausible-sounding detail, or fill a field to look complete.
- Leave a string empty and an array empty when the site does not say.
- Keep every list to at most 8 short entries.
- Do not include any text outside the JSON object.`

export type CompanyIdentityDraft = z.infer<typeof draftSchema>

export type CaptureResult =
  | {
      ok: true
      draft: CompanyIdentityDraft
      /** Provenance to store alongside the draft when the operator saves it. */
      capture: NonNullable<CompanyIdentitySettings['capture']>
      pages: string[]
    }
  | { ok: false; message: string }

/**
 * Draft a company identity from a website. Reads the public pages, then asks
 * the tenant's own model to summarise them — nothing is written to settings;
 * the operator reviews and edits the draft before saving it.
 */
export async function captureCompanyIdentity(args: {
  tenantId: string
  websiteUrl: string
  /** Which of the tenant's model providers reads the site. */
  providerSlug?: string
}): Promise<CaptureResult> {
  let root: URL
  try {
    const raw = args.websiteUrl.trim()
    root = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return { ok: false, message: 'That does not look like a website address.' }
  }
  if (root.protocol !== 'http:' && root.protocol !== 'https:') {
    return { ok: false, message: 'The website address must start with http:// or https://.' }
  }

  const providers = await listAiProviders(args.tenantId)
  const chosen = args.providerSlug
    ? providers.find((provider) => provider.slug === args.providerSlug)
    : providers[0]
  if (!chosen) {
    return {
      ok: false,
      message: 'Add a model provider under Intelligence → Models first — reading the site runs on your own key.',
    }
  }
  const config = await resolveProviderAiConfig(args.tenantId, chosen.slug)
  const model = config ? getModel(config, 'smart') : null
  if (!config || !model) {
    return { ok: false, message: `The "${chosen.slug}" provider key could not be opened. Re-add it under Models.` }
  }

  let site: CrawledSite
  try {
    site = await crawlSite(root)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  if (site.pages.length === 0 || site.content.trim().length < 200) {
    return {
      ok: false,
      message: `Not enough readable text at ${root.hostname}. The site may block automated readers or render entirely in the browser — fill the profile in by hand instead.`,
    }
  }

  let draft: CompanyIdentityDraft
  try {
    const { text } = await generateText({
      model,
      system: CAPTURE_SYSTEM,
      prompt: `Website: ${root.origin}\n\n${site.content}`,
    })
    draft = draftSchema.parse(extractJson(text))
  } catch (error) {
    return {
      ok: false,
      message: `The model could not turn that site into a profile: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (!draft.name.trim() && !draft.description.trim() && draft.services.length === 0) {
    return {
      ok: false,
      message: 'The site was read but nothing identifiable came back. Fill the profile in by hand instead.',
    }
  }

  return {
    ok: true,
    draft,
    capture: {
      websiteUrl: root.origin,
      capturedAt: new Date().toISOString(),
      provider: chosen.slug,
      model: config.modelSmart ?? chosen.modelSmart ?? chosen.provider,
      pagesRead: site.pages.length,
    },
    pages: site.pages.map((page) => page.url),
  }
}
