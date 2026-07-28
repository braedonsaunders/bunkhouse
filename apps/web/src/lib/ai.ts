import 'server-only'
import { and, eq } from 'drizzle-orm'
import { sealSecret, unsealSecret } from '@appkit/crypto'
import { isAiProvider, pingModel, type AiConfig } from '@appkit/ai'
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
  // Ping with the provider's DEFAULT text model: the key's validity is what's
  // being checked, and the chosen default may be an image model (which cannot
  // answer a text ping and used to block saving image-only providers).
  const probe: AiConfig = {
    provider: args.provider,
    apiKey: args.apiKey,
    ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
  }
  const ping = await pingModel(probe)
  if (!ping.ok) throw new Error(`Provider check failed: ${ping.message}`)

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
