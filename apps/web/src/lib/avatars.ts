import 'server-only'
import { and, eq } from 'drizzle-orm'
import {
  buildFullBodyPrompt,
  buildPortraitPrompt,
  generateImages,
  IMAGE_CAPABLE_PROVIDERS,
  type ImageModelId,
} from '@appkit/avatars'
import { avatarImages, people, tenantSettings } from '../db/schema'
import { db } from '../db/client'
import { listAiProviders, resolveProviderAiConfig } from './ai'

export const IMAGE_PROVIDER_KEY = 'images.provider'

/**
 * Image generation reuses the tenant's @appkit/ai providers — no separate
 * key. The setting just names which provider slug + image model to use.
 */
export type ImageProviderSetting = { providerSlug: string; model: ImageModelId }

export async function getImageProviderSetting(tenantId: string): Promise<ImageProviderSetting | null> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [row] = await app.db
      .select({ value: tenantSettings.value })
      .from(tenantSettings)
      .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, IMAGE_PROVIDER_KEY)))
    const value = row?.value as ImageProviderSetting | undefined
    return value?.providerSlug && value.model ? value : null
  })
}

export async function setImageProviderSetting(args: {
  tenantId: string
  providerSlug: string
  model: ImageModelId
}): Promise<void> {
  const providers = await listAiProviders(args.tenantId)
  const entry = providers.find((p) => p.slug === args.providerSlug)
  if (!entry) throw new Error(`No AI provider with slug "${args.providerSlug}" — add it under Model providers first.`)
  if (!(IMAGE_CAPABLE_PROVIDERS as readonly string[]).includes(entry.provider)) {
    throw new Error(`Provider kind "${entry.provider}" cannot generate images (use ${IMAGE_CAPABLE_PROVIDERS.join(' or ')}).`)
  }
  // The provider's live model API is the source of truth for valid ids —
  // providers add and retire image models without notice, so we only require
  // a non-empty id here rather than membership in a static catalog.
  const model = args.model.trim()
  if (!model) throw new Error('Pick an image model.')
  const value: ImageProviderSetting = { providerSlug: args.providerSlug, model }
  const app = db()
  await app.withTenant(args.tenantId, async () => {
    await app.db
      .insert(tenantSettings)
      .values({ tenantId: args.tenantId, key: IMAGE_PROVIDER_KEY, value })
      .onConflictDoUpdate({
        target: [tenantSettings.tenantId, tenantSettings.key],
        set: { value, updatedAt: new Date() },
      })
  })
}

export type AvatarKind = 'portrait' | 'full_body'

/** Generate likeness candidates for a person — portrait or standing figure. */
export async function generateHandAvatarCandidates(
  tenantId: string,
  personId: string,
  kind: AvatarKind = 'portrait',
): Promise<string[]> {
  const setting = await getImageProviderSetting(tenantId)
  if (!setting) throw new Error('No image provider configured — pick one in Settings → Image generation.')
  const config = await resolveProviderAiConfig(tenantId, setting.providerSlug)
  if (!config) throw new Error(`The "${setting.providerSlug}" provider is missing or its key cannot be unsealed.`)

  const app = db()
  const person = await app.withTenantContext(tenantId, async () => {
    const [row] = await app.db.select().from(people).where(eq(people.id, personId))
    return row
  })
  if (!person) throw new Error('Person not found.')

  const subject = {
    description: `${person.name}, ${person.title}`,
    ...(person.personality?.tone ? { tone: person.personality.tone } : {}),
  }
  const prompt = kind === 'full_body' ? buildFullBodyPrompt(subject) : buildPortraitPrompt(subject)
  const result = await generateImages(config, { prompt, model: setting.model, count: 4 })
  return result.images
}

/** Save the chosen portrait (one per person; choosing again replaces it). */
export async function saveHandAvatar(args: {
  tenantId: string
  personId: string
  dataUri: string
  model: string
  kind?: AvatarKind
}): Promise<void> {
  const match = args.dataUri.match(/^data:([^;]+);base64,(.+)$/s)
  if (!match) throw new Error('Avatar must be a base64 data URI.')
  const [, contentType, data] = match
  const app = db()
  await app.withTenant(args.tenantId, async () => {
    await app.db
      .insert(avatarImages)
      .values({
        tenantId: args.tenantId,
        personId: args.personId,
        kind: args.kind ?? 'portrait',
        contentType: contentType!,
        data: data!,
        model: args.model,
      })
      .onConflictDoUpdate({
        target: [avatarImages.tenantId, avatarImages.personId, avatarImages.kind],
        set: { contentType: contentType!, data: data!, model: args.model, updatedAt: new Date() },
      })
  })
}
