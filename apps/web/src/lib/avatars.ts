import 'server-only'
import { and, eq } from 'drizzle-orm'
import { sealSecret, unsealSecret, type SealedSecret } from '@appkit/crypto'
import {
  buildPortraitPrompt,
  generateImages,
  type ImageModelId,
  type ImageProviderConfig,
} from '@appkit/avatars'
import { avatarImages, people, tenantSettings } from '../db/schema'
import { db } from '../db/client'

export const IMAGE_PROVIDER_KEY = 'images.provider'

/** Tenant image-generation config; secrets sealed like every other credential. */
export type ImageProviderSetting =
  | { provider: 'cloudflare'; accountId: string; sealedApiToken: SealedSecret; model: ImageModelId }
  | { provider: 'replicate'; sealedApiToken: SealedSecret; model: ImageModelId }
  | { provider: 'gemini'; sealedApiKey: SealedSecret; model: ImageModelId }

export async function getImageProviderSetting(tenantId: string): Promise<ImageProviderSetting | null> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [row] = await app.db
      .select({ value: tenantSettings.value })
      .from(tenantSettings)
      .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, IMAGE_PROVIDER_KEY)))
    return (row?.value as ImageProviderSetting | undefined) ?? null
  })
}

export async function setImageProviderSetting(args: {
  tenantId: string
  provider: 'cloudflare' | 'replicate' | 'gemini'
  model: ImageModelId
  secret: string
  accountId?: string
}): Promise<void> {
  const sealed = sealSecret(args.secret)
  const value: ImageProviderSetting =
    args.provider === 'cloudflare'
      ? { provider: 'cloudflare', accountId: args.accountId ?? '', sealedApiToken: sealed, model: args.model }
      : args.provider === 'replicate'
        ? { provider: 'replicate', sealedApiToken: sealed, model: args.model }
        : { provider: 'gemini', sealedApiKey: sealed, model: args.model }
  if (value.provider === 'cloudflare' && !value.accountId) throw new Error('Cloudflare needs an account id.')

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

function toRuntimeConfig(setting: ImageProviderSetting): ImageProviderConfig {
  if (setting.provider === 'cloudflare') {
    const token = unsealSecret(setting.sealedApiToken)
    if (token === null) throw new Error('Image provider token cannot be unsealed.')
    return { provider: 'cloudflare', accountId: setting.accountId, apiToken: token }
  }
  if (setting.provider === 'replicate') {
    const token = unsealSecret(setting.sealedApiToken)
    if (token === null) throw new Error('Image provider token cannot be unsealed.')
    return { provider: 'replicate', apiToken: token }
  }
  const key = unsealSecret(setting.sealedApiKey)
  if (key === null) throw new Error('Image provider key cannot be unsealed.')
  return { provider: 'gemini', apiKey: key }
}

/** Generate portrait candidates for a hand from its personality. */
export async function generateHandAvatarCandidates(
  tenantId: string,
  personId: string,
): Promise<string[]> {
  const setting = await getImageProviderSetting(tenantId)
  if (!setting) throw new Error('No image provider configured — add one in Settings → Image generation.')
  const app = db()
  const person = await app.withTenantContext(tenantId, async () => {
    const [row] = await app.db.select().from(people).where(eq(people.id, personId))
    return row
  })
  if (!person) throw new Error('Person not found.')
  const { prompt, negativePrompt } = buildPortraitPrompt({
    description: `${person.name}, ${person.title}`,
    ...(person.personality?.tone ? { tone: person.personality.tone } : {}),
  })
  const result = await generateImages(toRuntimeConfig(setting), {
    prompt,
    negativePrompt,
    model: setting.model,
    count: 4,
  })
  return result.images
}

/** Save the chosen portrait (one per person; choosing again replaces it). */
export async function saveHandAvatar(args: {
  tenantId: string
  personId: string
  dataUri: string
  model: string
}): Promise<void> {
  const match = args.dataUri.match(/^data:([^;]+);base64,(.+)$/s)
  if (!match) throw new Error('Avatar must be a base64 data URI.')
  const [, contentType, data] = match
  const app = db()
  await app.withTenant(args.tenantId, async () => {
    await app.db
      .insert(avatarImages)
      .values({ tenantId: args.tenantId, personId: args.personId, contentType: contentType!, data: data!, model: args.model })
      .onConflictDoUpdate({
        target: [avatarImages.tenantId, avatarImages.personId],
        set: { contentType: contentType!, data: data!, model: args.model, updatedAt: new Date() },
      })
  })
}
