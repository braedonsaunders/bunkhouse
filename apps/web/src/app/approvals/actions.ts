'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { approvals, runs } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId } from '../../lib/tenant'

/**
 * Record a human decision on a pending approval. Decisions are final rows —
 * append-only doctrine — and the suspended run is released: rejected runs
 * complete immediately with the refusal noted; approved runs are marked ready
 * for the worker to resume with the sanctioned action (worker slice).
 */
async function decide(formData: FormData, status: 'approved' | 'rejected'): Promise<void> {
  const approvalId = String(formData.get('approvalId') ?? '')
  const note = String(formData.get('note') ?? '').trim() || null
  if (!approvalId) throw new Error('approvalId is required')

  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    const [row] = await app.db
      .update(approvals)
      .set({ status, decidedAt: new Date(), decisionNote: note })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, 'pending')))
      .returning({ runId: approvals.runId })
    if (!row) throw new Error('Approval already decided or not found.')
    if (status === 'rejected') {
      await app.db
        .update(runs)
        .set({ status: 'completed', finishedAt: new Date(), summary: 'Stopped: the requested action was declined.' })
        .where(and(eq(runs.id, row.runId), eq(runs.status, 'waiting_approval')))
    }
  })
  revalidatePath('/approvals')
  revalidatePath('/')
}

export async function approveAction(formData: FormData): Promise<void> {
  await decide(formData, 'approved')
}

export async function rejectAction(formData: FormData): Promise<void> {
  await decide(formData, 'rejected')
}
