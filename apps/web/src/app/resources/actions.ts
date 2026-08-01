'use server'

import { revalidatePath } from 'next/cache'
import { createNote, decideProposal, setNoteAssignment } from '../../lib/memory'
import { resolveTenantId as resolveTenant } from '../../lib/tenant'
const resolveTenantId = () => resolveTenant('resources.manage')
import { parseAssignment } from '../../lib/assignment'
import { db } from '../../db/client'

/** Author a company-knowledge note directly (humans only). */
export async function addCompanyNote(formData: FormData): Promise<void> {
  const title = String(formData.get('title') ?? '').trim()
  const body = String(formData.get('body') ?? '').trim()
  const kind = String(formData.get('kind') ?? 'fact') as 'fact' | 'episode' | 'procedure' | 'reflection'
  const importance = Number(formData.get('importance') ?? 3)
  if (!title || !body) throw new Error('A note needs a title and a body.')
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await createNote({
      tenantId,
      scope: 'company',
      personId: null,
      kind,
      title,
      body,
      author: 'human',
      importance,
      assignment: parseAssignment(formData),
    })
  })
  revalidatePath('/resources')
  revalidatePath('/roles')
}

/** Rebind which agents a piece of company knowledge reaches. */
export async function setCompanyNoteAssignment(formData: FormData): Promise<void> {
  const noteId = String(formData.get('memoryId') ?? '')
  if (!noteId) throw new Error('memoryId is required')
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await setNoteAssignment({ tenantId, noteId, assignment: parseAssignment(formData) })
  })
  revalidatePath('/resources')
  revalidatePath('/roles')
}

/** Human decision on a memory proposal (promotion etc). */
export async function decideMemoryProposal(formData: FormData): Promise<void> {
  const proposalId = String(formData.get('proposalId') ?? '')
  const approve = String(formData.get('decision') ?? '') === 'approve'
  if (!proposalId) throw new Error('proposalId is required')
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await decideProposal({ tenantId, proposalId, approve, decidedBy: 'human' })
  })
  revalidatePath('/resources')
  revalidatePath('/organization')
}
