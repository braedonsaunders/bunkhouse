import 'server-only'
import { asc, eq } from 'drizzle-orm'
import { departments, tenantSettings } from '../db/schema'
import { db } from '../db/client'

/**
 * The places a company has, and whether anybody wanders between them.
 *
 * The scene switcher was a wallpaper picker: six hardcoded rooms in
 * localStorage, every agent drawn on all of them. This makes it a floor plan —
 * departments are company data, agents belong to one, and the switcher moves
 * you between real places rather than changing the curtains.
 *
 * Backwards compatible on purpose. A department whose `sceneKind` is set draws
 * with exactly the artwork it always did, and the migration seeds the six
 * built-ins, so a company that has never touched this sees what it saw before
 * and gains meaning as it assigns desks.
 */

/** Whether people turn up in departments that are not their own. */
export const WANDERING_KEY = 'scene.wandering'

export type Department = {
  id: string
  name: string
  slug: string
  sceneKind: string | null
  backdropSvg: string | null
  /** The same room drawn for the light theme. */
  backdropSvgLight: string | null
  /** What was asked for, so a backdrop can be tweaked rather than re-described. */
  backdropPrompt: string | null
  position: number
}

/** Every department, in the order they should appear in the switcher. */
export async function listDepartments(tenantId: string): Promise<Department[]> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const rows = await app.db
      .select({
        id: departments.id,
        name: departments.name,
        slug: departments.slug,
        sceneKind: departments.sceneKind,
        backdropSvg: departments.backdropSvg,
        backdropSvgLight: departments.backdropSvgLight,
        backdropPrompt: departments.backdropPrompt,
        position: departments.position,
      })
      .from(departments)
      .orderBy(asc(departments.position), asc(departments.name))
    return rows
  })
}

/**
 * Is the whimsy switched on?
 *
 * Off by default. A company that has not asked for its staff to wander should
 * see everybody at their own desk — surprise movement is charming when it was
 * chosen and confusing when it was not.
 */
export async function wanderingEnabled(tenantId: string): Promise<boolean> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [row] = await app.db
      .select({ value: tenantSettings.value })
      .from(tenantSettings)
      .where(eq(tenantSettings.key, WANDERING_KEY))
    return row?.value === true
  })
}

export async function setWandering(tenantId: string, enabled: boolean): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .insert(tenantSettings)
      .values({ tenantId, key: WANDERING_KEY, value: enabled })
      .onConflictDoUpdate({
        target: [tenantSettings.tenantId, tenantSettings.key],
        set: { value: enabled, updatedAt: new Date() },
      })
  })
}
