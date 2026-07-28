import { createDb, schema as identity } from '@appkit/db'
import { and, eq } from 'drizzle-orm'
import { unsealSecret } from '@appkit/crypto'
import { buildPartPrompt, generateImages } from '@appkit/avatars'
import * as bunkhouse from '../src/db/schema/index.ts'
import { AVATAR_PART_CATEGORIES, AVATAR_PART_STYLE } from '../src/lib/avatar-parts.ts'

// Seed a starter parts library so the avatar composer is not empty on arrival.
//
// Every image is generated through the tenant's own configured image provider —
// nothing is bundled, nothing is invented. If no provider is configured the
// script says so and exits without writing, because a parts library made of
// placeholders is worse than an empty one.
//
// Idempotent by name: a part already in the library for a slot is left alone,
// so re-running only fills the gaps.

const url = process.env.BUNKHOUSE_DB_URL
const superUrl = process.env.BUNKHOUSE_SUPER_URL
if (!url || !superUrl) throw new Error('BUNKHOUSE_DB_URL and BUNKHOUSE_SUPER_URL must be set')

const SLUG = process.env.BUNKHOUSE_TENANT_SLUG ?? 'bunkhouse-demo'
const IMAGE_PROVIDER_KEY = 'images.provider'

/** Two or three takes per slot: enough variety to build distinct people. */
const STARTER_SET: { categoryId: string; parts: { name: string; description: string }[] }[] = [
  {
    categoryId: 'body',
    parts: [
      { name: 'Standing — slim', description: 'a slim adult standing figure with a medium skin tone' },
      { name: 'Standing — broad', description: 'a broad-shouldered adult standing figure with a deep skin tone' },
      { name: 'Standing — average', description: 'an average-build adult standing figure with a light skin tone' },
    ],
  },
  {
    categoryId: 'outfit',
    parts: [
      { name: 'Work shirt', description: 'a rolled-sleeve chambray work shirt over dark jeans' },
      { name: 'Blazer', description: 'a charcoal blazer over a white shirt and dark trousers' },
      { name: 'Safety vest', description: 'a hi-vis orange safety vest over a grey long-sleeve and work trousers' },
    ],
  },
  {
    categoryId: 'face',
    parts: [
      { name: 'Face — oval', description: 'a blank oval head and neck, medium skin tone' },
      { name: 'Face — round', description: 'a blank round head and neck, deep skin tone' },
      { name: 'Face — angular', description: 'a blank angular head and neck, light skin tone' },
    ],
  },
  {
    categoryId: 'eyes',
    parts: [
      { name: 'Eyes — open', description: 'a pair of alert open eyes, dark irises' },
      { name: 'Eyes — warm', description: 'a pair of softly smiling eyes, hazel irises' },
    ],
  },
  {
    categoryId: 'brows',
    parts: [
      { name: 'Brows — straight', description: 'a pair of straight, medium-thickness eyebrows, dark brown' },
      { name: 'Brows — arched', description: 'a pair of gently arched thin eyebrows, dark brown' },
    ],
  },
  {
    categoryId: 'mouth',
    parts: [
      { name: 'Mouth — smile', description: 'a closed, friendly smile' },
      { name: 'Mouth — neutral', description: 'a relaxed neutral mouth' },
    ],
  },
  {
    categoryId: 'hair',
    parts: [
      { name: 'Short crop', description: 'a short cropped hairstyle, dark brown' },
      { name: 'Shoulder length', description: 'a shoulder-length wavy hairstyle, dark brown' },
      { name: 'Tied back', description: 'hair tied back into a low bun, black' },
    ],
  },
  {
    categoryId: 'facial-hair',
    parts: [{ name: 'Short beard', description: 'a short, neatly trimmed full beard, dark brown' }],
  },
  {
    categoryId: 'headwear',
    parts: [{ name: 'Hard hat', description: 'a white construction hard hat' }],
  },
  {
    categoryId: 'accessory',
    parts: [{ name: 'Glasses', description: 'a pair of thin round wire-frame glasses' }],
  },
]

const schema = { ...identity, ...bunkhouse }
const app = createDb({ url, superUrl, schema })

const tenantId = await app.withSuperAdmin(async (superDb) => {
  const [tenant] = await superDb
    .select({ id: identity.tenants.id })
    .from(identity.tenants)
    .where(eq(identity.tenants.slug, SLUG))
  if (!tenant) throw new Error(`No tenant with slug "${SLUG}" — run db:seed first.`)
  return tenant.id
})

const setting = await app.withTenantContext(tenantId, async () => {
  const [row] = await app.db
    .select({ value: bunkhouse.tenantSettings.value })
    .from(bunkhouse.tenantSettings)
    .where(
      and(
        eq(bunkhouse.tenantSettings.tenantId, tenantId),
        eq(bunkhouse.tenantSettings.key, IMAGE_PROVIDER_KEY),
      ),
    )
  return row?.value as { providerSlug: string; model: string } | undefined
})

if (!setting?.providerSlug || !setting.model) {
  console.error(
    'No image provider is configured for this company.\n' +
      'Open Settings → Image generation, pick one of your model providers and an image model,\n' +
      'then run this again. Nothing was written.',
  )
  process.exit(1)
}

// Providers live in tenant settings with their key sealed; this script runs
// outside a request, so it opens the key the same way the app does at use time
// rather than reaching for the request-scoped helper.
const providers = await app.withTenantContext(tenantId, async () => {
  const [row] = await app.db
    .select({ value: bunkhouse.tenantSettings.value })
    .from(bunkhouse.tenantSettings)
    .where(
      and(
        eq(bunkhouse.tenantSettings.tenantId, tenantId),
        eq(bunkhouse.tenantSettings.key, bunkhouse.AI_PROVIDERS_KEY),
      ),
    )
  return (row?.value as bunkhouse.AiProviderEntry[] | undefined) ?? []
})
const entry = providers.find((candidate) => candidate.slug === setting.providerSlug)
if (!entry) {
  console.error(`The "${setting.providerSlug}" provider is no longer configured. Nothing was written.`)
  process.exit(1)
}
const apiKey = unsealSecret(entry.sealedApiKey)
if (apiKey === null) {
  console.error(`The "${setting.providerSlug}" key could not be opened. Nothing was written.`)
  process.exit(1)
}
const config = { provider: entry.provider, apiKey, baseUrl: entry.baseUrl ?? null }

const existing = await app.withTenantContext(tenantId, async () =>
  app.db
    .select({ categoryId: bunkhouse.avatarParts.categoryId, name: bunkhouse.avatarParts.name })
    .from(bunkhouse.avatarParts),
)
const have = new Set(existing.map((row) => `${row.categoryId}:${row.name}`))

let written = 0
let skipped = 0
for (const group of STARTER_SET) {
  const category = AVATAR_PART_CATEGORIES.find((candidate) => candidate.id === group.categoryId)
  if (!category) continue
  for (const part of group.parts) {
    if (have.has(`${group.categoryId}:${part.name}`)) {
      skipped++
      continue
    }
    const { prompt } = buildPartPrompt({
      description: part.description,
      categoryLabel: category.label,
      ...(category.promptAddition ? { promptAddition: category.promptAddition } : {}),
      styleSuffix: AVATAR_PART_STYLE,
    })
    process.stdout.write(`${category.label} · ${part.name}… `)
    let images: string[]
    try {
      const result = await generateImages(config, { prompt, model: setting.model, count: 1 })
      images = result.images
    } catch (error) {
      console.log('failed')
      console.error(`  ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const first = images[0]
    const match = first?.match(/^data:([^;]+);base64,(.+)$/s)
    if (!match) {
      console.log('no image returned')
      continue
    }
    await app.withTenant(tenantId, async () => {
      await app.db.insert(bunkhouse.avatarParts).values({
        tenantId,
        categoryId: group.categoryId,
        name: part.name,
        contentType: match[1]!,
        data: match[2]!,
        model: setting.model,
        prompt,
        tags: ['starter'],
      })
    })
    written++
    console.log('kept')
  }
}

console.log(
  `\nStarter library: ${written} part${written === 1 ? '' : 's'} generated, ${skipped} already present.\n` +
    'Review them under Settings → Avatar parts, then compose each person from their record.',
)
process.exit(0)
