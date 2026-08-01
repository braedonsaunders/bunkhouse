'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { procedureRevisions, procedures, type ProcedureAssignment } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId as resolveTenant } from '../../lib/tenant'
const resolveTenantId = () => resolveTenant('resources.manage')
import { parseProcedureContent, renderProcedureBody } from '../../lib/procedures'

function parseAssignment(formData: FormData): ProcedureAssignment {
  if (String(formData.get('everyone') ?? '') === 'on') return { everyone: true }
  const rolePacks = String(formData.get('rolePacks') ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
  const personIds = String(formData.get('personIds') ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
  return { ...(rolePacks.length ? { rolePacks } : {}), ...(personIds.length ? { personIds } : {}) }
}

/** Author a new procedure: head + revision 1, active immediately. */
export async function createProcedure(formData: FormData): Promise<void> {
  const title = String(formData.get('title') ?? '').trim()
  if (!title) throw new Error('A procedure needs a title.')
  const content = parseProcedureContent(String(formData.get('content') ?? ''))
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    const [head] = await app.db
      .insert(procedures)
      .values({ tenantId, slug, title, status: 'active', currentVersion: 1, assignment: parseAssignment(formData), source: { type: 'authored' } })
      .returning({ id: procedures.id })
    if (!head) throw new Error(`A procedure with slug "${slug}" may already exist.`)
    await app.db.insert(procedureRevisions).values({
      tenantId,
      procedureId: head.id,
      version: 1,
      body: renderProcedureBody(content),
      content,
      changeNote: 'Initial version.',
    })
  })
  revalidatePath('/resources')
}

/** Append a revision: new version row, head pointer advances. Version-pinned history stays. */
export async function addRevision(formData: FormData): Promise<void> {
  const procedureId = String(formData.get('procedureId') ?? '')
  if (!procedureId) throw new Error('procedureId is required.')
  const content = parseProcedureContent(String(formData.get('content') ?? ''))
  const changeNote = String(formData.get('changeNote') ?? '').trim() || null

  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    const [head] = await app.db.select().from(procedures).where(eq(procedures.id, procedureId))
    if (!head) throw new Error('Procedure not found.')
    const version = head.currentVersion + 1
    await app.db
      .insert(procedureRevisions)
      .values({ tenantId, procedureId, version, body: renderProcedureBody(content), content, changeNote })
    await app.db.update(procedures).set({ currentVersion: version, updatedAt: new Date() }).where(eq(procedures.id, procedureId))
  })
  revalidatePath('/resources')
}

/** Activate or retire; retired procedures stop binding but keep history. */
export async function setProcedureStatus(formData: FormData): Promise<void> {
  const procedureId = String(formData.get('procedureId') ?? '')
  const status = String(formData.get('status') ?? '') as 'active' | 'retired'
  if (!procedureId || !['active', 'retired'].includes(status)) throw new Error('Invalid status change.')
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db.update(procedures).set({ status, updatedAt: new Date() }).where(eq(procedures.id, procedureId))
  })
  revalidatePath('/resources')
}

/** Rebind who the procedure applies to. */
export async function setProcedureAssignment(formData: FormData): Promise<void> {
  const procedureId = String(formData.get('procedureId') ?? '')
  if (!procedureId) throw new Error('procedureId is required.')
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .update(procedures)
      .set({ assignment: parseAssignment(formData), updatedAt: new Date() })
      .where(and(eq(procedures.id, procedureId)))
  })
  revalidatePath('/resources')
}
