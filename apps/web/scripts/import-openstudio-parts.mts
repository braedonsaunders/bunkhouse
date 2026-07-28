/**
 * Import a starter parts library from an OpenStudio deployment.
 *
 * OpenStudio's `/api/avatar/library` is public and returns its categories plus
 * every component with a presigned image URL. Those parts are already drawn in
 * one house style and alpha-cut, which is exactly what a fresh bunkhouse needs
 * before anyone can compose a figure.
 *
 * Their category vocabulary is not ours, so each component is mapped onto the
 * closest slot in lib/avatar-parts.ts; anything with no home (instruments) is
 * skipped and reported rather than dumped into a wrong layer.
 *
 *   pnpm --filter web run import:openstudio-parts [-- --source https://…] [--limit 4]
 */
import { and, eq, sql } from 'drizzle-orm'
import { avatarParts } from '../src/db/schema'
import { db } from '../src/db/client'
import { AVATAR_PART_CATEGORIES } from '../src/lib/avatar-parts'
import { resolveTenantId } from '../src/lib/tenant'

type OpenStudioComponent = {
  id: string
  categoryId: string
  name: string
  imageUrl: string
  colorVariants?: Record<string, string> | null
  tags?: string[] | null
  isActive?: boolean
}

const args = process.argv.slice(2)
const flag = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback
}
const SOURCE = flag('source', 'https://www.openstudio.cafe')
/** Parts kept per category — a starter pack, not the whole catalogue. */
const LIMIT = Number(flag('limit', '6'))

/**
 * OpenStudio slot → bunkhouse slot. Their vocabulary is finer than ours in
 * places (base and outer clothing are both outfits here) and coarser in others
 * (they have no separate eyes/brows/mouth — those live inside their face art).
 * Unlisted slots are skipped by design and reported at the end.
 */
const CATEGORY_MAP: Record<string, string> = {
  body: 'body',
  face: 'face',
  hair_front: 'hair',
  clothing_base: 'outfit',
  clothing_outer: 'outfit',
  accessory_head: 'headwear',
  accessory_neck: 'accessory',
}

const known = new Set(AVATAR_PART_CATEGORIES.map((c) => c.id))
for (const [from, to] of Object.entries(CATEGORY_MAP)) {
  if (!known.has(to)) {
    throw new Error(
      `Mapping sends "${from}" to "${to}", which is not a category in lib/avatar-parts.ts (have: ${[...known].join(', ')}).`,
    )
  }
}

const response = await fetch(`${SOURCE}/api/avatar/library`, {
  headers: { accept: 'application/json' },
  signal: AbortSignal.timeout(30_000),
})
if (!response.ok) throw new Error(`Library fetch failed: ${response.status} ${response.statusText}`)
const library = (await response.json()) as { components?: OpenStudioComponent[] }
const components = (library.components ?? []).filter((c) => c.isActive !== false)
if (components.length === 0) throw new Error('The source library returned no components.')

// Deterministic pick: the first N of each mapped slot, so a re-run imports the
// same starter pack rather than a random draw.
const byCategory = new Map<string, OpenStudioComponent[]>()
for (const component of components) {
  const target = CATEGORY_MAP[component.categoryId]
  if (!target) continue
  const list = byCategory.get(target) ?? []
  if (list.length < LIMIT) list.push(component)
  byCategory.set(target, list)
}

const skipped = new Set(components.map((c) => c.categoryId).filter((id) => !CATEGORY_MAP[id]))
const tenantId = await resolveTenantId()
const app = db()

let imported = 0
let replaced = 0
const failures: string[] = []

for (const [categoryId, list] of byCategory) {
  for (const component of list) {
    try {
      const image = await fetch(component.imageUrl, { signal: AbortSignal.timeout(30_000) })
      if (!image.ok) throw new Error(`image fetch ${image.status}`)
      const contentType = image.headers.get('content-type') ?? 'image/png'
      const data = Buffer.from(await image.arrayBuffer()).toString('base64')
      const name = component.name?.trim() || component.id

      await app.withTenant(tenantId, async () => {
        // Re-running the import refreshes a part rather than duplicating it.
        const existing = await app.db
          .select({ id: avatarParts.id })
          .from(avatarParts)
          .where(
            and(
              eq(avatarParts.categoryId, categoryId),
              eq(avatarParts.name, name),
              sql`${avatarParts.model} = 'openstudio-import'`,
            ),
          )
          .limit(1)
        if (existing[0]) {
          await app.db
            .update(avatarParts)
            .set({ contentType, data, updatedAt: new Date() })
            .where(eq(avatarParts.id, existing[0].id))
          replaced += 1
          return
        }
        await app.db.insert(avatarParts).values({
          tenantId,
          categoryId,
          name,
          contentType,
          data,
          tags: component.tags ?? [],
          model: 'openstudio-import',
        })
        imported += 1
      })
      process.stdout.write('.')
    } catch (error) {
      failures.push(`${component.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

process.stdout.write('\n')
console.log(`imported ${imported} part(s), refreshed ${replaced}, from ${SOURCE}`)
for (const [categoryId, list] of byCategory) console.log(`  ${categoryId}: ${list.length}`)
if (skipped.size > 0) console.log(`skipped source categories with no bunkhouse slot: ${[...skipped].join(', ')}`)
if (failures.length > 0) {
  console.log(`${failures.length} part(s) failed:`)
  for (const failure of failures.slice(0, 10)) console.log(`  ${failure}`)
}

await app.pool.end()
await app.superPool.end()
