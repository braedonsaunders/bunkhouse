import 'server-only'
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm'
import { modelPrices, people } from '../db/schema'
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

type OpenRouterModel = {
  id: string
  pricing?: { prompt?: string; completion?: string }
}

/**
 * Refresh prices from OpenRouter's public catalog (USD per token → per Mtok).
 * Only models this tenant actually uses get rows (assigned hand models), plus
 * any extra ids passed in. A row is appended only when the price CHANGED —
 * effective-dated audit, no churn.
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

  const app = db()
  return app.withTenant(tenantId, async () => {
    const hands = await app.db
      .select({ modelConfig: people.modelConfig })
      .from(people)
      .where(and(eq(people.kind, 'hand'), sql`${people.modelConfig} is not null`))
    const wanted = new Set<string>(extraModels.filter(Boolean))
    for (const hand of hands) if (hand.modelConfig?.model) wanted.add(hand.modelConfig.model)

    const updated: string[] = []
    const unmatched: string[] = []
    for (const model of wanted) {
      // OpenRouter ids are vendor-prefixed (anthropic/claude-…): match by suffix.
      const hit =
        catalog.find((c) => c.id === model) ??
        catalog.find((c) => c.id.endsWith(`/${model}`)) ??
        catalog.find((c) => c.id.split('/').pop() === model)
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
