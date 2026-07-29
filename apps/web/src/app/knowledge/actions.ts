'use server'

import { revalidatePath } from 'next/cache'
import { createNote, decideProposal } from '../../lib/memory'
import { resolveTenantId } from '../../lib/tenant'
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
    await createNote({ tenantId, scope: 'company', personId: null, kind, title, body, author: 'human', importance })
  })
  revalidatePath('/knowledge')
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
  revalidatePath('/knowledge')
  revalidatePath('/organization')
}
