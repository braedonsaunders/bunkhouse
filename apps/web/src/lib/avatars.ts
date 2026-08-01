import 'server-only'
import { and, asc, eq } from 'drizzle-orm'
import {
  buildPartPrompt,
  createEmptyComposition,
  generateImages,
  sortLayers,
  IMAGE_CAPABLE_PROVIDERS,
  type AvatarComposition,
  type AvatarPart,
  type AvatarPartCategory,
  type ImageModelId,
} from '@appkit/avatars'
import { avatarCompositions, avatarParts, tenantSettings } from '../db/schema'
import { db } from '../db/client'
import { listAiProviders, resolveProviderAiConfig } from './ai'
import { AVATAR_PART_STYLE, avatarPartCategory } from './avatar-parts'

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

// ---------------------------------------------------------------------------
// The parts library
// ---------------------------------------------------------------------------

export type AvatarPartRow = {
  id: string
  categoryId: string
  name: string
  colorVariant: string | null
  tags: string[]
  model: string
  prompt: string | null
  createdAt: Date
}

export async function listAvatarPartRows(tenantId: string): Promise<AvatarPartRow[]> {
  const app = db()
  return app.withTenantContext(tenantId, async () =>
    app.db
      .select({
        id: avatarParts.id,
        categoryId: avatarParts.categoryId,
        name: avatarParts.name,
        colorVariant: avatarParts.colorVariant,
        tags: avatarParts.tags,
        model: avatarParts.model,
        prompt: avatarParts.prompt,
        createdAt: avatarParts.createdAt,
      })
      .from(avatarParts)
      .orderBy(asc(avatarParts.categoryId), asc(avatarParts.name)),
  )
}

/**
 * The library shaped for the composer and every renderer.
 *
 * Colour variants collapse into their base part: rows sharing a category and a
 * name are one part, and the variant rows become its `colorVariants` map, so
 * the composer offers a colour picker instead of five near-identical entries.
 */
export async function loadAvatarPartLibrary(tenantId: string): Promise<AvatarPart[]> {
  const rows = await listAvatarPartRows(tenantId)
  const byKey = new Map<string, AvatarPart>()

  for (const row of rows.filter((r) => !r.colorVariant)) {
    byKey.set(`${row.categoryId}:${row.name}`, {
      id: row.id,
      categoryId: row.categoryId,
      name: row.name,
      imageUrl: avatarPartUrl(row.id),
      ...(row.tags.length > 0 ? { tags: row.tags } : {}),
    })
  }

  for (const row of rows.filter((r) => r.colorVariant)) {
    const base = byKey.get(`${row.categoryId}:${row.name}`)
    if (base) {
      base.colorVariants = { ...base.colorVariants, [row.colorVariant!]: avatarPartUrl(row.id) }
      continue
    }
    // A variant whose base was removed still deserves to be usable.
    byKey.set(`${row.categoryId}:${row.name}:${row.colorVariant}`, {
      id: row.id,
      categoryId: row.categoryId,
      name: `${row.name} (${row.colorVariant})`,
      imageUrl: avatarPartUrl(row.id),
      ...(row.tags.length > 0 ? { tags: row.tags } : {}),
    })
  }

  return [...byKey.values()]
}

export function avatarPartUrl(partId: string): string {
  return `/api/avatar-parts/${partId}`
}

/**
 * Generate candidate images for one library part.
 *
 * The prompt discipline lives in @appkit/avatars: the category says what the
 * part is, the tenant house style says how the set is drawn, and the shared
 * suffix demands an alpha-cut isolated object — parts stack, so anything with
 * a baked-in background is unusable.
 */
export async function generateAvatarPartCandidates(args: {
  tenantId: string
  categoryId: string
  description: string
  count?: number
}): Promise<{ images: string[]; model: string; prompt: string }> {
  const category = avatarPartCategory(args.categoryId)
  if (!category) throw new Error(`Unknown part category "${args.categoryId}".`)
  const description = args.description.trim()
  if (!description) throw new Error('Describe the part you want.')

  const setting = await getImageProviderSetting(args.tenantId)
  if (!setting) throw new Error('No image provider configured — pick one in Settings → Image generation.')
  const config = await resolveProviderAiConfig(args.tenantId, setting.providerSlug)
  if (!config) throw new Error(`The "${setting.providerSlug}" provider is missing or its key cannot be unsealed.`)

  const { prompt } = buildPartPrompt({
    description,
    categoryLabel: category.label,
    ...(category.promptAddition ? { promptAddition: category.promptAddition } : {}),
    styleSuffix: AVATAR_PART_STYLE,
  })
  const result = await generateImages(config, { prompt, model: setting.model, count: args.count ?? 4 })
  return { images: result.images, model: result.model, prompt }
}

/** Keep a generated candidate in the tenant's library. */
export async function saveAvatarPart(args: {
  tenantId: string
  categoryId: string
  name: string
  dataUri: string
  model: string
  prompt?: string
  colorVariant?: string
  tags?: string[]
}): Promise<string> {
  if (!avatarPartCategory(args.categoryId)) throw new Error(`Unknown part category "${args.categoryId}".`)
  const name = args.name.trim()
  if (!name) throw new Error('Give the part a name.')
  const match = args.dataUri.match(/^data:([^;]+);base64,(.+)$/s)
  if (!match) throw new Error('A part must be a base64 data URI.')
  const [, contentType, data] = match

  const app = db()
  return app.withTenant(args.tenantId, async () => {
    const [row] = await app.db
      .insert(avatarParts)
      .values({
        tenantId: args.tenantId,
        categoryId: args.categoryId,
        name,
        contentType: contentType!,
        data: data!,
        model: args.model,
        ...(args.prompt ? { prompt: args.prompt } : {}),
        ...(args.colorVariant ? { colorVariant: args.colorVariant } : {}),
        ...(args.tags?.length ? { tags: args.tags } : {}),
      })
      .returning({ id: avatarParts.id })
    return row!.id
  })
}

export async function renameAvatarPart(args: {
  tenantId: string
  partId: string
  name: string
  tags: string[]
}): Promise<void> {
  const name = args.name.trim()
  if (!name) throw new Error('Give the part a name.')
  const app = db()
  await app.withTenant(args.tenantId, async () => {
    await app.db
      .update(avatarParts)
      .set({ name, tags: args.tags, updatedAt: new Date() })
      .where(eq(avatarParts.id, args.partId))
  })
}

/**
 * Remove a part from the library.
 *
 * Compositions wearing it are left alone: `sortLayers` skips a placement whose
 * part no longer exists, so a figure degrades to the parts that remain rather
 * than breaking, and the composer shows the empty slot for someone to refill.
 */
export async function deleteAvatarPart(tenantId: string, partId: string): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db.delete(avatarParts).where(eq(avatarParts.id, partId))
  })
}

// ---------------------------------------------------------------------------
// Per-person compositions
// ---------------------------------------------------------------------------

export async function getAvatarComposition(
  tenantId: string,
  personId: string,
): Promise<AvatarComposition | null> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [row] = await app.db
      .select({ composition: avatarCompositions.composition })
      .from(avatarCompositions)
      .where(eq(avatarCompositions.personId, personId))
    return row?.composition ?? null
  })
}

/** Every person's figure, for the directory and the lobby. */
export async function listAvatarCompositions(
  tenantId: string,
): Promise<Map<string, AvatarComposition>> {
  const app = db()
  const rows = await app.withTenantContext(tenantId, async () =>
    app.db
      .select({ personId: avatarCompositions.personId, composition: avatarCompositions.composition })
      .from(avatarCompositions),
  )
  return new Map(rows.map((row) => [row.personId, row.composition]))
}

/**
 * Whether this composition actually draws somebody.
 *
 * Not the same question as "is there a row". The composer saves work in
 * progress, so a person can hold a composition with nothing placed in it; and
 * deleting a library part deliberately leaves the placements wearing it alone,
 * so a composition can outlive its own artwork. Both render as empty air, so
 * the test is that the composition resolves to at least one paintable layer.
 */
export function hasDrawnFigure(
  composition: AvatarComposition | null | undefined,
  parts: readonly AvatarPart[],
  categories: readonly AvatarPartCategory[],
): boolean {
  return composition ? sortLayers(composition, parts, categories).length > 0 : false
}

export async function saveAvatarComposition(args: {
  tenantId: string
  personId: string
  composition: AvatarComposition
}): Promise<void> {
  const composition = args.composition
  if (composition?.version !== 1 || typeof composition.parts !== 'object' || !composition.headViewport) {
    throw new Error('That avatar could not be read — reopen the composer and save again.')
  }
  const app = db()
  await app.withTenant(args.tenantId, async () => {
    await app.db
      .insert(avatarCompositions)
      .values({ tenantId: args.tenantId, personId: args.personId, composition })
      .onConflictDoUpdate({
        target: [avatarCompositions.tenantId, avatarCompositions.personId],
        set: { composition, updatedAt: new Date() },
      })
  })
}

export { createEmptyComposition }
