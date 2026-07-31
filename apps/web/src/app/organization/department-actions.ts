'use server'

import { and, eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { departments, people } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId } from '../../lib/tenant'
import { setWandering } from '../../lib/departments'
import { generateBackdrop } from '../../lib/scene-backdrop'
import { sanitiseSceneSvg } from '../../lib/scene-svg'

/*
 * Where these screens actually live.
 *
 * Every one of these revalidated `/organization/departments`, a route that has
 * not existed since departments moved under company settings — so nothing was
 * ever refetched, and saving a backdrop wrote the new drawing and left the
 * page rendering the old one. A path that does not resolve to a route is not
 * an error, it is silently nothing, which is why this survived.
 */
const DEPARTMENTS_PAGE = '/admin/settings'

/**
 * Editing the company's places.
 *
 * Every one of these re-reads the tenant from the session rather than trusting
 * anything the form sent — a department id in a hidden field is a request, not
 * a permission, and the row is always matched on `tenantId` as well as `id`.
 */

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'department'
  )
}

export async function createDepartment(formData: FormData): Promise<void> {
  const name = String(formData.get('name') ?? '').trim()
  if (!name) return
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    const [last] = await app.db
      .select({ max: sql<number>`coalesce(max(${departments.position}), -1)`.mapWith(Number) })
      .from(departments)
    // A name somebody already used gets a suffix rather than an error: the
    // slug only has to be unique, and being told "that exists" while renaming
    // a room is a worse experience than getting "sales-2".
    const base = slugify(name)
    const taken = new Set(
      (await app.db.select({ slug: departments.slug }).from(departments)).map((row) => row.slug),
    )
    let slug = base
    for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`
    // A department can be born with its own backdrop rather than having to be
    // created, reopened and drawn — sanitised here like any other saved
    // drawing, because it has travelled through a browser to get here.
    const drawn = String(formData.get('backdropSvg') ?? '')
    const drawnLight = String(formData.get('backdropSvgLight') ?? '')
    const cleaned = drawn ? sanitiseSceneSvg(drawn) : null
    const svg = cleaned && 'svg' in cleaned ? cleaned.svg : null
    const cleanedLight = drawnLight ? sanitiseSceneSvg(drawnLight) : null
    const svgLight = cleanedLight && 'svg' in cleanedLight ? cleanedLight.svg : null
    await app.db.insert(departments).values({
      tenantId,
      name: name.slice(0, 60),
      slug,
      // One or the other: a drawing means there is no built-in room to fall
      // back to, which is exactly what a null sceneKind means everywhere else.
      sceneKind: svg ? null : String(formData.get('sceneKind') ?? 'office') || 'office',
      ...(svg
        ? {
            backdropSvg: svg,
            backdropSvgLight: svgLight,
            backdropPrompt: String(formData.get('backdropPrompt') ?? '').slice(0, 400),
          }
        : {}),
      position: (last?.max ?? -1) + 1,
    })
  })
  revalidatePath(DEPARTMENTS_PAGE)
  revalidatePath('/')
}

export async function renameDepartment(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  if (!id || !name) return
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .update(departments)
      .set({ name: name.slice(0, 60), updatedAt: new Date() })
      .where(and(eq(departments.id, id), eq(departments.tenantId, tenantId)))
  })
  revalidatePath(DEPARTMENTS_PAGE)
  revalidatePath('/')
}

export async function moveDepartment(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '')
  const direction = String(formData.get('direction') ?? '')
  if (!id || (direction !== 'up' && direction !== 'down')) return
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    const all = await app.db
      .select({ id: departments.id, position: departments.position })
      .from(departments)
      .orderBy(departments.position)
    const index = all.findIndex((row) => row.id === id)
    const swapWith = direction === 'up' ? index - 1 : index + 1
    if (index === -1 || swapWith < 0 || swapWith >= all.length) return
    // Positions are rewritten wholesale rather than swapped in place, because
    // seeded rows can share a position and a swap between two zeroes does
    // nothing at all.
    const reordered = [...all]
    const [moved] = reordered.splice(index, 1)
    reordered.splice(swapWith, 0, moved!)
    for (const [position, row] of reordered.entries()) {
      await app.db
        .update(departments)
        .set({ position, updatedAt: new Date() })
        .where(and(eq(departments.id, row.id), eq(departments.tenantId, tenantId)))
    }
  })
  revalidatePath(DEPARTMENTS_PAGE)
  revalidatePath('/')
}

export async function deleteDepartment(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '')
  if (!id) return
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    // Anybody who worked here loses their desk rather than their record. A
    // person whose department was deleted appears on every floor, which is the
    // same as never having been given one.
    await app.db
      .update(people)
      .set({ departmentId: null, updatedAt: new Date() })
      .where(and(eq(people.departmentId, id), eq(people.tenantId, tenantId)))
    await app.db.delete(departments).where(and(eq(departments.id, id), eq(departments.tenantId, tenantId)))
  })
  revalidatePath(DEPARTMENTS_PAGE)
  revalidatePath('/')
}

export async function setPersonDepartment(formData: FormData): Promise<void> {
  const personId = String(formData.get('personId') ?? '')
  const raw = String(formData.get('departmentId') ?? '')
  if (!personId) return
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .update(people)
      .set({ departmentId: raw === '' ? null : raw, updatedAt: new Date() })
      .where(and(eq(people.id, personId), eq(people.tenantId, tenantId)))
  })
  revalidatePath('/organization')
  revalidatePath(DEPARTMENTS_PAGE)
  revalidatePath('/')
}

export async function setWanderingEnabled(formData: FormData): Promise<void> {
  const tenantId = await resolveTenantId()
  await setWandering(tenantId, String(formData.get('enabled') ?? '') === 'on')
  revalidatePath(DEPARTMENTS_PAGE)
  revalidatePath('/')
}

/**
 * Draw a backdrop for one department.
 *
 * Returns the sanitised markup for a PREVIEW rather than saving it: a picture
 * you cannot look at before committing to is a lottery, and models draw a dud
 * often enough that the preview is the point.
 */
export async function draftBackdrop(
  _previous: unknown,
  formData: FormData,
): Promise<{ dark?: string; light?: string; error?: string; prompt?: string }> {
  const description = String(formData.get('description') ?? '')
  const tenantId = await resolveTenantId()
  const result = await generateBackdrop({ tenantId, description })
  if (!result.ok) return { error: result.reason, prompt: description }
  return { dark: result.dark, light: result.light, prompt: description }
}

/** Keep the drawing that was previewed. */
export async function saveBackdrop(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '')
  const svg = String(formData.get('svg') ?? '')
  const svgLight = String(formData.get('svgLight') ?? '')
  const prompt = String(formData.get('prompt') ?? '')
  if (!id || !svg) return
  // Sanitised AGAIN on the way in. The preview came from this server, but the
  // form it travelled through is a browser, and anything that has been through
  // a browser is something the user could have replaced.
  const cleaned = sanitiseSceneSvg(svg)
  if (!('svg' in cleaned) || !cleaned.svg) return
  const cleanedLight = svgLight ? sanitiseSceneSvg(svgLight) : null
  const lightSvg = cleanedLight && 'svg' in cleanedLight ? cleanedLight.svg : null
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .update(departments)
      .set({
        backdropSvg: cleaned.svg,
        backdropSvgLight: lightSvg,
        backdropPrompt: prompt.slice(0, 400),
        sceneKind: null,
        updatedAt: new Date(),
      })
      .where(and(eq(departments.id, id), eq(departments.tenantId, tenantId)))
  })
  revalidatePath(DEPARTMENTS_PAGE)
  revalidatePath('/')
}

/** Go back to one of the hand-drawn rooms. */
export async function clearBackdrop(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '')
  const sceneKind = String(formData.get('sceneKind') ?? 'office') || 'office'
  if (!id) return
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .update(departments)
      .set({ backdropSvg: null, backdropSvgLight: null, sceneKind, updatedAt: new Date() })
      .where(and(eq(departments.id, id), eq(departments.tenantId, tenantId)))
  })
  revalidatePath(DEPARTMENTS_PAGE)
  revalidatePath('/')
}
