import 'server-only'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { sealSecret, unsealSecret } from '@appkit/crypto'
import {
  AI_BILLING_KEY,
  costReconciliations,
  tenantSettings,
  tokenSpend,
  type AiBillingSettings,
} from '../db/schema'
import { db } from '../db/client'
import { listAiProviders } from './ai'

/**
 * Checking the books against the people who send them.
 *
 * Neither Anthropic nor OpenAI publishes a price list a program can read, but
 * both will say what they charged: daily totals for the whole organization,
 * available a day or so in arrears through an administration key. That is real
 * money, and it is the only real money either of them offers.
 *
 * It cannot be spent against an agent's salary — a daily organization-wide
 * total belongs to no particular run, and pretending otherwise would put an
 * invented attribution into a ledger whose whole value is that it is true. So
 * the per-person ledger is left exactly as the runs wrote it, and the
 * provider's figure is banked beside it as a measurement: here is what we
 * counted, here is what we were charged, here is the gap. A gap that does not
 * close is a price table that needs correcting, and now an operator can see it
 * instead of discovering it on a credit-card statement.
 *
 * The prices are never rewritten from this automatically. A number the company
 * is billed is an average across a day of traffic; back-solving a per-token
 * rate from it and silently reinterpreting future spend would be exactly the
 * kind of quiet mutation the rest of the ledger is built to avoid.
 */

/** The provider kinds that expose a cost report at all. */
export const RECONCILABLE_PROVIDERS = ['anthropic', 'openai'] as const
export type ReconcilableProvider = (typeof RECONCILABLE_PROVIDERS)[number]

export function isReconcilableProvider(value: string): value is ReconcilableProvider {
  return (RECONCILABLE_PROVIDERS as readonly string[]).includes(value)
}

const TIMEOUT_MS = 30_000
const day = (date: Date): string => date.toISOString().slice(0, 10)
const midnightUtc = (date: Date): Date => new Date(`${day(date)}T00:00:00.000Z`)

// --- Administration keys ----------------------------------------------------

async function readBilling(tenantId: string): Promise<AiBillingSettings> {
  const app = db()
  const [row] = await app.db
    .select({ value: tenantSettings.value })
    .from(tenantSettings)
    .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, AI_BILLING_KEY)))
  return (row?.value as AiBillingSettings | undefined) ?? {}
}

async function writeBilling(tenantId: string, value: AiBillingSettings): Promise<void> {
  const app = db()
  await app.db
    .insert(tenantSettings)
    .values({ tenantId, key: AI_BILLING_KEY, value })
    .onConflictDoUpdate({
      target: [tenantSettings.tenantId, tenantSettings.key],
      set: { value, updatedAt: new Date() },
    })
}

/** Which providers have an administration key connected. */
export async function billingKeyStatus(tenantId: string): Promise<Record<ReconcilableProvider, boolean>> {
  const app = db()
  const billing = await app.withTenantContext(tenantId, () => readBilling(tenantId))
  return { anthropic: Boolean(billing.anthropic), openai: Boolean(billing.openai) }
}

/**
 * Save an administration key, proved against the provider's own cost report
 * before it is sealed. An inference key pasted here would look fine and then
 * fail silently every night; asking for yesterday's bill settles it now.
 */
export async function setBillingKey(args: {
  tenantId: string
  provider: ReconcilableProvider
  adminKey: string
}): Promise<void> {
  const yesterday = new Date(Date.now() - 86_400_000)
  const probe =
    args.provider === 'anthropic'
      ? await fetchAnthropicCosts(args.adminKey, yesterday)
      : await fetchOpenAiCosts(args.adminKey, yesterday)
  if (!probe.ok) throw new Error(probe.message)

  const app = db()
  await app.withTenant(args.tenantId, async () => {
    const current = await readBilling(args.tenantId)
    await writeBilling(args.tenantId, { ...current, [args.provider]: { sealedAdminKey: sealSecret(args.adminKey) } })
  })
}

export async function removeBillingKey(tenantId: string, provider: ReconcilableProvider): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    const next = { ...(await readBilling(tenantId)) }
    delete next[provider]
    await writeBilling(tenantId, next)
  })
}

async function resolveBillingKey(tenantId: string, provider: ReconcilableProvider): Promise<string | null> {
  const app = db()
  const billing = await app.withTenantContext(tenantId, () => readBilling(tenantId))
  const entry = billing[provider]
  if (!entry) return null
  return unsealSecret(entry.sealedAdminKey)
}

// --- Provider cost reports --------------------------------------------------

/** One day's charge for one model, as a provider reported it. */
type ReportedBucket = { day: string; model: string; usd: number }
type CostReport = { ok: true; buckets: ReportedBucket[]; sourceRef: string | null } | { ok: false; message: string }

function accumulate(into: Map<string, ReportedBucket>, day: string, model: string, usd: number): void {
  if (!Number.isFinite(usd) || usd === 0) return
  const key = `${day} ${model}`
  const existing = into.get(key)
  if (existing) existing.usd += usd
  else into.set(key, { day, model, usd })
}

type AnthropicCostResponse = {
  data?: {
    starting_at?: string
    results?: { amount?: string | number; currency?: string; model?: string | null; workspace_id?: string | null }[]
  }[]
}

/**
 * Anthropic's cost report: daily buckets from `starting_at`, grouped by model
 * so a drift can be pinned to the model that caused it. Non-USD results are
 * dropped rather than converted — this ledger deals in the currency the rest of
 * the app deals in, and inventing an exchange rate would be a second guess on
 * top of the first.
 */
async function fetchAnthropicCosts(adminKey: string, since: Date): Promise<CostReport> {
  const url = new URL('https://api.anthropic.com/v1/organizations/cost_report')
  url.searchParams.set('starting_at', midnightUtc(since).toISOString())
  url.searchParams.set('limit', '31')
  url.searchParams.append('group_by[]', 'description')
  try {
    const response = await fetch(url, {
      headers: {
        'x-api-key': adminKey,
        'anthropic-version': '2023-06-01',
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      const detail =
        response.status === 401 || response.status === 403
          ? ' — this needs an Anthropic administration key (sk-ant-admin-…), not an agent key'
          : ''
      return { ok: false, message: `Anthropic cost report returned ${response.status}${detail}.` }
    }
    const body = (await response.json()) as AnthropicCostResponse
    const buckets = new Map<string, ReportedBucket>()
    let sourceRef: string | null = null
    for (const bucket of body.data ?? []) {
      if (!bucket.starting_at) continue
      const bucketDay = bucket.starting_at.slice(0, 10)
      for (const result of bucket.results ?? []) {
        if (result.currency && result.currency.toUpperCase() !== 'USD') continue
        sourceRef ??= result.workspace_id ?? null
        accumulate(buckets, bucketDay, result.model?.trim() || '*', Number(result.amount))
      }
    }
    return { ok: true, buckets: [...buckets.values()], sourceRef }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

type OpenAiCostResponse = {
  data?: {
    start_time?: number
    results?: {
      amount?: { value?: number; currency?: string }
      line_item?: string | null
      project_id?: string | null
    }[]
  }[]
}

/**
 * OpenAI's cost report: daily buckets keyed by Unix start time, grouped by line
 * item — the closest thing it offers to a model, and enough to tell inference
 * apart from everything else on the invoice.
 */
async function fetchOpenAiCosts(adminKey: string, since: Date): Promise<CostReport> {
  const url = new URL('https://api.openai.com/v1/organization/costs')
  url.searchParams.set('start_time', String(Math.floor(midnightUtc(since).getTime() / 1000)))
  url.searchParams.set('bucket_width', '1d')
  url.searchParams.set('limit', '31')
  url.searchParams.append('group_by', 'line_item')
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${adminKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      const detail =
        response.status === 401 || response.status === 403 || response.status === 404
          ? ' — this needs an OpenAI administration key from the organization settings, not an agent key'
          : ''
      return { ok: false, message: `OpenAI cost report returned ${response.status}${detail}.` }
    }
    const body = (await response.json()) as OpenAiCostResponse
    const buckets = new Map<string, ReportedBucket>()
    let sourceRef: string | null = null
    for (const bucket of body.data ?? []) {
      if (typeof bucket.start_time !== 'number') continue
      const bucketDay = day(new Date(bucket.start_time * 1000))
      for (const result of bucket.results ?? []) {
        const currency = result.amount?.currency
        if (currency && currency.toUpperCase() !== 'USD') continue
        sourceRef ??= result.project_id ?? null
        accumulate(buckets, bucketDay, result.line_item?.trim() || '*', Number(result.amount?.value))
      }
    }
    return { ok: true, buckets: [...buckets.values()], sourceRef }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

// --- The reconciliation pass ------------------------------------------------

export type ReconcileOutcome = {
  provider: ReconcilableProvider
  /** Days that gained a row because their figures moved. */
  recorded: number
  /** Total drift over the window: reported − ledger, in USD. */
  driftUsd: number
  message?: string
}

/**
 * The company's own estimate for a provider over a window, day by day. Voice
 * minutes are excluded: they are billed by a speech provider, not by the model
 * provider whose invoice is being checked.
 */
async function ledgerByDay(
  tenantId: string,
  providerSlugs: string[],
  since: Date,
): Promise<Map<string, number>> {
  if (providerSlugs.length === 0) return new Map()
  const app = db()
  const rows = await app.withTenantContext(tenantId, () =>
    app.db
      .select({
        day: sql<string>`to_char(${tokenSpend.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`,
        cost: sql<string>`coalesce(sum(${tokenSpend.costUsd}), 0)`,
      })
      .from(tokenSpend)
      .where(
        and(
          gte(tokenSpend.createdAt, midnightUtc(since)),
          sql`${tokenSpend.provider} = any(${providerSlugs})`,
          sql`(${tokenSpend.inputTokens} > 0 or ${tokenSpend.outputTokens} > 0)`,
        ),
      )
      .groupBy(sql`1`),
  )
  return new Map(rows.map((row) => [row.day, Number(row.cost)]))
}

/**
 * Compare one provider's invoice against the ledger over the trailing window
 * and append what changed. Nothing is written for a day whose figures match the
 * last reading — the table is a record of movements, not a daily heartbeat.
 */
export async function reconcileProvider(args: {
  tenantId: string
  provider: ReconcilableProvider
  days?: number
}): Promise<ReconcileOutcome> {
  const provider = args.provider
  const since = new Date(Date.now() - (args.days ?? 30) * 86_400_000)
  const adminKey = await resolveBillingKey(args.tenantId, provider)
  if (adminKey === null) {
    return { provider, recorded: 0, driftUsd: 0, message: 'No administration key is connected for this provider.' }
  }

  const report =
    provider === 'anthropic' ? await fetchAnthropicCosts(adminKey, since) : await fetchOpenAiCosts(adminKey, since)
  if (!report.ok) return { provider, recorded: 0, driftUsd: 0, message: report.message }

  // Spend rows carry the tenant's provider SLUG, not the provider kind, so the
  // ledger side has to be gathered by every slug of that kind.
  const slugs = (await listAiProviders(args.tenantId))
    .filter((entry) => entry.provider === provider)
    .map((entry) => entry.slug)
  const ledger = await ledgerByDay(args.tenantId, slugs, since)

  // A day's whole invoice is compared against a day's whole ledger — the
  // provider's per-model split and ours do not line up (a line item is not a
  // model id), so a per-model comparison would manufacture drift that is really
  // just two different ways of naming the same spend.
  const reportedByDay = new Map<string, number>()
  const modelsByDay = new Map<string, ReportedBucket[]>()
  for (const bucket of report.buckets) {
    reportedByDay.set(bucket.day, (reportedByDay.get(bucket.day) ?? 0) + bucket.usd)
    modelsByDay.set(bucket.day, [...(modelsByDay.get(bucket.day) ?? []), bucket])
  }

  const app = db()
  let recorded = 0
  let driftTotal = 0
  await app.withTenant(args.tenantId, async () => {
    for (const [bucketDay, reportedUsd] of [...reportedByDay].sort()) {
      const ledgerUsd = ledger.get(bucketDay) ?? 0
      const drift = reportedUsd - ledgerUsd
      driftTotal += drift
      // One row per (day, model) so a drift can be traced to what caused it;
      // the ledger figure is the day's, repeated, because that is the only
      // granularity the comparison is honest at.
      for (const bucket of modelsByDay.get(bucketDay) ?? []) {
        const share = reportedUsd === 0 ? 0 : bucket.usd / reportedUsd
        const modelLedger = ledgerUsd * share
        const [latest] = await app.db
          .select()
          .from(costReconciliations)
          .where(
            and(
              eq(costReconciliations.provider, provider),
              eq(costReconciliations.day, bucketDay),
              eq(costReconciliations.model, bucket.model),
            ),
          )
          .orderBy(desc(costReconciliations.fetchedAt))
          .limit(1)
        const reported = bucket.usd.toFixed(4)
        const ledgered = modelLedger.toFixed(4)
        if (latest && latest.reportedUsd === reported && latest.ledgerUsd === ledgered) continue
        await app.db.insert(costReconciliations).values({
          tenantId: args.tenantId,
          provider,
          day: bucketDay,
          model: bucket.model,
          reportedUsd: reported,
          ledgerUsd: ledgered,
          driftUsd: (bucket.usd - modelLedger).toFixed(4),
          ...(report.sourceRef ? { sourceRef: report.sourceRef } : {}),
        })
        recorded += 1
      }
    }
  })

  return { provider, recorded, driftUsd: driftTotal }
}

/** Reconcile every provider kind this company has an administration key for. */
export async function reconcileTenant(tenantId: string, days = 30): Promise<ReconcileOutcome[]> {
  const status = await billingKeyStatus(tenantId)
  const outcomes: ReconcileOutcome[] = []
  for (const provider of RECONCILABLE_PROVIDERS) {
    if (!status[provider]) continue
    outcomes.push(await reconcileProvider({ tenantId, provider, days }))
  }
  return outcomes
}

export type ReconciliationRow = {
  id: string
  provider: string
  day: string
  model: string
  reportedUsd: number
  ledgerUsd: number
  driftUsd: number
  fetchedAt: Date
}

/**
 * The latest reading for each day and model — the audit trail keeps every
 * earlier one, but a screen should show what is true now.
 */
export async function listReconciliations(tenantId: string, days = 30): Promise<ReconciliationRow[]> {
  const app = db()
  const since = day(new Date(Date.now() - days * 86_400_000))
  const rows = await app.withTenantContext(tenantId, () =>
    app.db
      .select()
      .from(costReconciliations)
      .where(gte(costReconciliations.day, since))
      .orderBy(desc(costReconciliations.day), desc(costReconciliations.fetchedAt)),
  )
  const seen = new Set<string>()
  const latest: ReconciliationRow[] = []
  for (const row of rows) {
    const key = `${row.provider} ${row.day} ${row.model}`
    if (seen.has(key)) continue
    seen.add(key)
    latest.push({
      id: row.id,
      provider: row.provider,
      day: row.day,
      model: row.model,
      reportedUsd: Number(row.reportedUsd),
      ledgerUsd: Number(row.ledgerUsd),
      driftUsd: Number(row.driftUsd),
      fetchedAt: row.fetchedAt,
    })
  }
  return latest
}
