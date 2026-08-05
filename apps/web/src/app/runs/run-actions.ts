'use server'

import { revalidatePath } from 'next/cache'
import { and, eq, inArray } from 'drizzle-orm'
import { approvals, runs } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId as resolveTenant } from '../../lib/tenant'
import { appendRunEventInTransaction } from '../../lib/run-events'

/**
 * Stopping a run an operator no longer wants.
 *
 * The states this has to cover are not the same problem. A parked run —
 * waiting on an approval or a reply — is not executing at all: nothing is
 * running to interrupt, and it would sit there indefinitely because the thing
 * it waits for is never coming. A live run IS executing, on a worker that
 * knows nothing about this request, so the row is the message: the loop reads
 * it between steps and stops at the next boundary.
 *
 * Either way the run keeps everything it did. Stopping is not undoing.
 */
const resolveTenantId = () => resolveTenant('work.manage')

/** The states a run can still be stopped from; anything else has finished. */
const STOPPABLE = ['running', 'waiting_approval', 'waiting_reply'] as const

export async function stopRunAction(
  runId: string,
): Promise<{ ok: true; live: boolean } | { ok: false; message: string }> {
  if (!runId) return { ok: false, message: 'No run was named.' }
  const tenantId = await resolveTenantId()
  const app = db()

  return app.withTenant(tenantId, async () => {
    const [run] = await app.db.select().from(runs).where(eq(runs.id, runId))
    if (!run) return { ok: false, message: 'That run no longer exists.' }
    if (!STOPPABLE.includes(run.status as (typeof STOPPABLE)[number])) {
      return { ok: false, message: `This run already ${run.status === 'cancelled' ? 'stopped' : 'finished'}.` }
    }

    // Said on the timeline before the row changes, so the record explains
    // itself to whoever reads it later rather than just ending mid-sentence.
    await appendRunEventInTransaction(app.db, {
      tenantId,
      runId,
      kind: 'message',
      payload: { text: 'Stopped by an operator. Everything done up to this point is kept.' },
    })

    // Whatever it was waiting on is settled too. A pending approval whose run
    // is gone is a decision nobody can act on: approving it would resume a run
    // that has been stopped, and leaving it queued asks a human to rule on
    // work that no longer exists. `executedAt` is what keeps the executor from
    // picking it up afterwards.
    const decided = await app.db
      .update(approvals)
      .set({
        status: 'rejected',
        decidedAt: new Date(),
        decisionNote: 'Declined automatically — the run that requested this was stopped.',
        executedAt: new Date(),
        executionStatus: 'succeeded',
        updatedAt: new Date(),
      })
      .where(and(eq(approvals.runId, runId), eq(approvals.status, 'pending')))
      .returning({ id: approvals.id })

    await app.db
      .update(runs)
      .set({
        status: 'cancelled',
        finishedAt: new Date(),
        // The transcript only exists to resume a parked run. Nothing will.
        transcript: null,
        waiting: null,
        summary: 'Stopped by an operator.',
        updatedAt: new Date(),
      })
      .where(and(eq(runs.id, runId), inArray(runs.status, [...STOPPABLE])))

    // The observatory hosts the record as a drawer, so this covers both the
    // list and the open flyout. The `/runs/[id]` deep link is not revalidated
    // by id on purpose — see the revalidation test for why matching a dynamic
    // route by literal is a trap — and does not need to be: the caller
    // refreshes the route it is on.
    revalidatePath('/observatory')
    revalidatePath('/approvals')
    if (decided.length > 0) revalidatePath('/organization')
    // A live run stops at its next step boundary rather than instantly, and
    // the caller says so rather than implying the work is already over.
    return { ok: true, live: run.status === 'running' }
  })
}
