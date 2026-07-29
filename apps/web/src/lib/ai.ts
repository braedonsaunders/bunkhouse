import 'server-only'
import { and, eq } from 'drizzle-orm'
import { sealSecret, unsealSecret } from '@appkit/crypto'
import { isAiProvider, pingModel, type AiConfig, type AiProvider } from '@appkit/ai'
import { AI_PROVIDERS_KEY, people, tenantSettings, type AiProviderEntry } from '../db/schema'
import { db } from '../db/client'

async function readProviders(tenantId: string): Promise<AiProviderEntry[]> {
  const app = db()
  const [row] = await app.db
    .select({ value: tenantSettings.value })
    .from(tenantSettings)
    .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, AI_PROVIDERS_KEY)))
  return (row?.value as AiProviderEntry[] | undefined) ?? []
}

async function writeProviders(tenantId: string, providers: AiProviderEntry[]): Promise<void> {
  const app = db()
  await app.db
    .insert(tenantSettings)
    .values({ tenantId, key: AI_PROVIDERS_KEY, value: providers })
    .onConflictDoUpdate({
      target: [tenantSettings.tenantId, tenantSettings.key],
      set: { value: providers, updatedAt: new Date() },
    })
}

export async function listAiProviders(tenantId: string): Promise<AiProviderEntry[]> {
  const app = db()
  return app.withTenantContext(tenantId, () => readProviders(tenantId))
}

/**
 * Prove the key works by pinging the models this provider will actually be
 * used with, then the provider's built-in default as a fallback. Both ends
 * matter: an aggregator retires model slugs out from under the built-in
 * default (OpenRouter has dropped several), which would reject a perfectly
 * good key — while a chosen model may be an image model that cannot answer
 * a text ping, which is what the built-in default covers.
 */
async function verifyProviderKey(args: {
  provider: AiProvider
  apiKey: string
  baseUrl?: string
  modelSmart?: string
  modelFast?: string
}): Promise<void> {
  const probe = (model?: string): AiConfig => ({
    provider: args.provider,
    apiKey: args.apiKey,
    ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
    ...(model ? { modelFast: model } : {}),
  })
  const attempts: (string | undefined)[] = []
  for (const chosen of [args.modelFast, args.modelSmart]) {
    if (chosen && !attempts.includes(chosen)) attempts.push(chosen)
  }
  attempts.push(undefined)

  const failures: string[] = []
  for (const model of attempts) {
    const ping = await pingModel(probe(model))
    if (ping.ok) return
    failures.push(`${model ?? "the provider's default model"} — ${ping.message}`)
  }
  throw new Error(`Provider check failed. ${failures.join('; ')}`)
}

/** Verify the key actually answers a prompt before it is ever saved. */
export async function addAiProvider(args: {
  tenantId: string
  slug: string
  provider: string
  label: string
  apiKey: string
  baseUrl?: string
  modelSmart?: string
  modelFast?: string
}): Promise<void> {
  if (!isAiProvider(args.provider)) throw new Error(`Unknown provider kind: ${args.provider}`)
  await verifyProviderKey({
    provider: args.provider,
    apiKey: args.apiKey,
    ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
    ...(args.modelSmart ? { modelSmart: args.modelSmart } : {}),
    ...(args.modelFast ? { modelFast: args.modelFast } : {}),
  })

  const app = db()
  await app.withTenant(args.tenantId, async () => {
    const providers = await readProviders(args.tenantId)
    if (providers.some((p) => p.slug === args.slug)) {
      throw new Error(`A provider with slug "${args.slug}" already exists.`)
    }
    providers.push({
      slug: args.slug,
      provider: args.provider,
      label: args.label,
      sealedApiKey: sealSecret(args.apiKey),
      ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
      ...(args.modelSmart ? { modelSmart: args.modelSmart } : {}),
      ...(args.modelFast ? { modelFast: args.modelFast } : {}),
    })
    await writeProviders(args.tenantId, providers)
  })
}

/**
 * Change a saved provider: its display label, the models agents fall back to,
 * and — when the company rotates it — the key itself. The slug never moves,
 * because every agent's modelConfig points at it. A replacement key is proved
 * against the live API before it displaces the working one.
 */
export async function updateAiProvider(args: {
  tenantId: string
  slug: string
  label: string
  modelSmart?: string
  modelFast?: string
  /** Only when the key is being rotated; blank keeps the sealed one. */
  apiKey?: string
}): Promise<void> {
  const app = db()
  const providers = await app.withTenantContext(args.tenantId, () => readProviders(args.tenantId))
  const entry = providers.find((p) => p.slug === args.slug)
  if (!entry) throw new Error(`No provider "${args.slug}".`)
  if (!isAiProvider(entry.provider)) throw new Error(`Provider kind ${entry.provider} is invalid.`)

  const apiKey = args.apiKey?.trim() ? args.apiKey.trim() : unsealSecret(entry.sealedApiKey)
  if (apiKey === null) throw new Error('The stored key cannot be unsealed — replace it to save changes.')
  await verifyProviderKey({
    provider: entry.provider,
    apiKey,
    ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
    ...(args.modelSmart ? { modelSmart: args.modelSmart } : {}),
    ...(args.modelFast ? { modelFast: args.modelFast } : {}),
  })

  await app.withTenant(args.tenantId, async () => {
    const current = await readProviders(args.tenantId)
    const next: AiProviderEntry[] = current.map((p) => {
      if (p.slug !== args.slug) return p
      return {
        slug: p.slug,
        provider: p.provider,
        label: args.label,
        sealedApiKey: args.apiKey?.trim() ? sealSecret(args.apiKey.trim()) : p.sealedApiKey,
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
        ...(args.modelSmart ? { modelSmart: args.modelSmart } : {}),
        ...(args.modelFast ? { modelFast: args.modelFast } : {}),
      }
    })
    await writeProviders(args.tenantId, next)
  })
}

export async function removeAiProvider(tenantId: string, slug: string): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    const providers = await readProviders(tenantId)
    await writeProviders(
      tenantId,
      providers.filter((p) => p.slug !== slug),
    )
  })
}

/** Resolve one tenant provider slug to a live AiConfig (key unsealed at use time). */
export async function resolveProviderAiConfig(tenantId: string, slug: string): Promise<AiConfig | null> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const providers = await readProviders(tenantId)
    const entry = providers.find((p) => p.slug === slug)
    if (!entry || !isAiProvider(entry.provider)) return null
    const apiKey = unsealSecret(entry.sealedApiKey)
    if (apiKey === null) return null
    return {
      provider: entry.provider,
      apiKey,
      modelSmart: entry.modelSmart ?? null,
      modelFast: entry.modelFast ?? null,
      baseUrl: entry.baseUrl ?? null,
    }
  })
}

/**
 * Resolve the live AiConfig for an agent: its modelConfig names a tenant
 * provider slug + model; the sealed key is opened only here, at use time.
 */
export async function resolveAgentAiConfig(tenantId: string, personId: string): Promise<AiConfig | null> {
  const app = db()
  const person = await app.withTenantContext(tenantId, async () => {
    const [row] = await app.db.select().from(people).where(eq(people.id, personId))
    return row
  })
  if (!person?.modelConfig) return null
  const base = await resolveProviderAiConfig(tenantId, person.modelConfig.provider)
  if (!base) return null
  return {
    ...base,
    modelSmart: person.modelConfig.model || base.modelSmart || null,
    baseUrl: person.modelConfig.baseUrl ?? base.baseUrl ?? null,
  }
}
