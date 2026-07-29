import 'server-only'
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm'
import { AI_PROVIDERS_KEY, modelPrices, people, tenantSettings, type AiProviderEntry } from '../db/schema'
import { db } from '../db/client'

export type ResolvedPrice = {
  inputUsdPerMtok: number
  outputUsdPerMtok: number
  source: 'openrouter' | 'manual' | 'unpriced'
}

/**
 * The price in force for a model at a moment: latest effective row for the
 * exact model id, else the '*' wildcard, else explicitly unpriced (cost 0,
 * flagged on the spend row — visible, never silently guessed).
 */
export async function resolvePrice(tenantId: string, model: string, at: Date = new Date()): Promise<ResolvedPrice> {
  const app = db()
  const rows = await app.db
    .select()
    .from(modelPrices)
    .where(and(inArray(modelPrices.model, [model, '*']), lte(modelPrices.effectiveAt, at)))
    .orderBy(desc(modelPrices.effectiveAt))
  const exact = rows.find((r) => r.model === model) ?? rows.find((r) => r.model === '*')
  if (!exact) return { inputUsdPerMtok: 0, outputUsdPerMtok: 0, source: 'unpriced' }
  return {
    inputUsdPerMtok: Number(exact.inputUsdPerMtok),
    outputUsdPerMtok: Number(exact.outputUsdPerMtok),
    source: exact.source,
  }
}

/** The spend-ledger columns for one model call, priced. */
export type PricedSpend = {
  costUsd: string
  inputUsdPerMtok: string | null
  outputUsdPerMtok: string | null
  priceSource: 'provider' | 'openrouter' | 'manual' | 'unpriced'
}

/**
 * What to bank for one model call.
 *
 * A cost the provider reported is money, not an estimate, and wins outright —
 * it already accounts for which upstream served the request and what the cache
 * saved, neither of which a token count knows. The per-Mtok columns stay null
 * on those rows rather than being back-solved: no single rate produced that
 * number, and inventing one would put a figure in the audit trail that nobody
 * ever charged.
 *
 * Everything else is priced from the effective-dated table, stamping the exact
 * rate used. An unpriced model still writes its row — the tokens are real and
 * the salary meter must see them — flagged so the zero is legible as "nobody
 * has told us what this costs" rather than "this was free".
 */
export async function priceSpend(args: {
  tenantId: string
  model: string
  inputTokens: number
  outputTokens: number
  /** USD the provider itself reported for this call, when it reported any. */
  reportedCostUsd?: number
}): Promise<PricedSpend> {
  if (args.reportedCostUsd !== undefined && Number.isFinite(args.reportedCostUsd) && args.reportedCostUsd >= 0) {
    return {
      costUsd: args.reportedCostUsd.toFixed(6),
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      priceSource: 'provider',
    }
  }
  const price = await resolvePrice(args.tenantId, args.model)
  const cost =
    (args.inputTokens * price.inputUsdPerMtok + args.outputTokens * price.outputUsdPerMtok) / 1_000_000
  return {
    costUsd: cost.toFixed(6),
    inputUsdPerMtok: price.inputUsdPerMtok.toFixed(4),
    outputUsdPerMtok: price.outputUsdPerMtok.toFixed(4),
    priceSource: price.source,
  }
}

export async function listPrices(tenantId: string) {
  const app = db()
  return app.withTenantContext(tenantId, () =>
    app.db.select().from(modelPrices).orderBy(modelPrices.model, desc(modelPrices.effectiveAt)),
  )
}

/** Append a manual price row (append-only; a change is a new effective row). */
export async function setManualPrice(args: {
  tenantId: string
  model: string
  inputUsdPerMtok: number
  outputUsdPerMtok: number
}): Promise<void> {
  const app = db()
  await app.withTenant(args.tenantId, async () => {
    await app.db.insert(modelPrices).values({
      tenantId: args.tenantId,
      model: args.model.trim() || '*',
      inputUsdPerMtok: args.inputUsdPerMtok.toFixed(4),
      outputUsdPerMtok: args.outputUsdPerMtok.toFixed(4),
      source: 'manual',
    })
  })
}

/**
 * Every model id this company can actually spend on: the ones its agents are
 * assigned, and the defaults their providers fall back to when an agent names
 * none. Both can reach the ledger, so both need a price.
 */
export async function modelsInUse(tenantId: string): Promise<string[]> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const agents = await app.db
      .select({ modelConfig: people.modelConfig })
      .from(people)
      .where(and(eq(people.kind, 'agent'), sql`${people.modelConfig} is not null`))
    const [settings] = await app.db
      .select({ value: tenantSettings.value })
      .from(tenantSettings)
      .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, AI_PROVIDERS_KEY)))
    const providers = (settings?.value as AiProviderEntry[] | undefined) ?? []

    const wanted = new Set<string>()
    for (const agent of agents) if (agent.modelConfig?.model) wanted.add(agent.modelConfig.model)
    for (const provider of providers) {
      if (provider.modelSmart) wanted.add(provider.modelSmart)
      if (provider.modelFast) wanted.add(provider.modelFast)
    }
    return [...wanted]
  })
}

/** Models in use that no effective price row covers — the source of $0 spend. */
export async function unpricedModelsInUse(tenantId: string): Promise<string[]> {
  const app = db()
  const models = await modelsInUse(tenantId)
  if (models.length === 0) return []
  return app.withTenantContext(tenantId, async () => {
    const unpriced: string[] = []
    for (const model of models) {
      const price = await resolvePrice(tenantId, model)
      if (price.source === 'unpriced') unpriced.push(model)
    }
    return unpriced
  })
}

type OpenRouterModel = {
  id: string
  pricing?: { prompt?: string; completion?: string }
}

/**
 * Reduce a model id to the part vendors actually agree on.
 *
 * The same model is written several ways by the people who serve it. A native
 * Anthropic key wants `claude-haiku-4-5-20251001`; the catalogue lists it as
 * `anthropic/claude-haiku-4.5`. Dropping the vendor prefix, the release date
 * and every separator leaves `claudehaiku45` on both sides — which is what a
 * human means when they say those are the same model. Everything else stays,
 * so `gpt-4o` and `gpt-4o-mini`, or a `:free` variant and its paid twin, never
 * collapse into each other.
 */
function normalizeModelId(id: string): string {
  const withoutVendor = id.toLowerCase().split('/').pop() ?? id.toLowerCase()
  const withoutDate = withoutVendor.replace(/[-_]?20\d{6}$/, '')
  return withoutDate.replace(/[^a-z0-9]/g, '')
}

/**
 * The catalogue entry for a model id. Exact match first, then a vendor-prefixed
 * id, and only then the normalized comparison — narrowest reading wins, so a
 * loose match can never displace an exact one. Where several entries normalize
 * alike (a `:free` or `:thinking` variant beside the plain model) the shortest
 * id is the plain one.
 */
function matchCatalog(catalog: OpenRouterModel[], model: string): OpenRouterModel | undefined {
  const exact = catalog.find((c) => c.id === model)
  if (exact) return exact
  const suffix = catalog.find((c) => c.id.endsWith(`/${model}`))
  if (suffix) return suffix
  const target = normalizeModelId(model)
  if (!target) return undefined
  const near = catalog.filter((c) => normalizeModelId(c.id) === target)
  return near.sort((a, b) => a.id.length - b.id.length)[0]
}

/**
 * Refresh prices from OpenRouter's public catalog (USD per token → per Mtok).
 * Only models this tenant actually uses get rows, plus any extra ids passed in.
 * A row is appended only when the price CHANGED — effective-dated audit, no
 * churn.
 *
 * This is the fallback path. Where a provider reports its own cost the ledger
 * uses that instead and never consults these rows; they exist for the providers
 * that bill in tokens and leave the arithmetic to their customers.
 */
export async function refreshPricesFromOpenRouter(
  tenantId: string,
  extraModels: string[] = [],
): Promise<{ updated: string[]; unmatched: string[] }> {
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`OpenRouter catalog fetch failed: ${response.status}`)
  const catalog = ((await response.json()) as { data: OpenRouterModel[] }).data

  const inUse = await modelsInUse(tenantId)
  const app = db()
  return app.withTenant(tenantId, async () => {
    const wanted = new Set<string>([...inUse, ...extraModels.filter(Boolean)])

    const updated: string[] = []
    const unmatched: string[] = []
    for (const model of wanted) {
      const hit = matchCatalog(catalog, model)
      const prompt = Number(hit?.pricing?.prompt)
      const completion = Number(hit?.pricing?.completion)
      if (!hit || !Number.isFinite(prompt) || !Number.isFinite(completion)) {
        unmatched.push(model)
        continue
      }
      const inputUsdPerMtok = (prompt * 1_000_000).toFixed(4)
      const outputUsdPerMtok = (completion * 1_000_000).toFixed(4)
      const [current] = await app.db
        .select()
        .from(modelPrices)
        .where(and(eq(modelPrices.model, model)))
        .orderBy(desc(modelPrices.effectiveAt))
        .limit(1)
      if (
        current &&
        current.inputUsdPerMtok === inputUsdPerMtok &&
        current.outputUsdPerMtok === outputUsdPerMtok
      ) {
        continue
      }
      await app.db.insert(modelPrices).values({
        tenantId,
        model,
        inputUsdPerMtok,
        outputUsdPerMtok,
        source: 'openrouter',
        sourceRef: hit.id,
      })
      updated.push(model)
    }
    return { updated, unmatched }
  })
}
