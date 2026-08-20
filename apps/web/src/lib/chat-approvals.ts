import { asc, inArray } from 'drizzle-orm'
import { approvals } from '../db/schema'
import { db } from '../db/client'
import { approvalCategoryLabel, approvalPresentation } from './approval-presentation'
import { getThread } from './chat-threads'

export type ChatApprovalView = {
  id: string
  runId: string
  categoryLabel: string
  description: string
  details: Array<{ label: string; value: string }>
  /**
   * `failed` is not a decision — it is what became of one. The row still says
   * approved or rejected; this view resolves the two together so the
   * conversation can distinguish "waiting to continue" from "never will".
   */
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'failed'
  decisionNote: string | null
  /** Why carrying the decision out was given up on, when it was. */
  failureReason: string | null
  /** The decision is final, but its parked run has not finished resuming yet. */
  continuationPending: boolean
  createdAt: string
}

/** Approval requests raised by runs visibly attached to this conversation. */
export async function listThreadApprovals(tenantId: string, threadId: string): Promise<ChatApprovalView[]> {
  const detail = await getThread(tenantId, threadId)
  if (!detail) return []
  const runIds = [...new Set(detail.messages.map((message) => message.runId).filter((id): id is string => Boolean(id)))]
  if (runIds.length === 0) return []

  const app = db()
  const rows = await app.withTenantContext(tenantId, () => app.db
    .select({
      id: approvals.id,
      runId: approvals.runId,
      category: approvals.category,
      payload: approvals.payload,
      status: approvals.status,
      decisionNote: approvals.decisionNote,
      executedAt: approvals.executedAt,
      executionError: approvals.executionError,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .where(inArray(approvals.runId, runIds))
    .orderBy(asc(approvals.createdAt)))

  return rows.map((row) => {
    const presentation = approvalPresentation(row.payload)
    return {
      id: row.id,
      runId: row.runId,
      categoryLabel: approvalCategoryLabel(row.category),
      description: row.payload.description,
      details: [
        ...presentation.fields,
        ...(presentation.text ? [{ label: 'Details', value: presentation.text }] : []),
      ],
      // Terminal is the STAMP, not the status column: `execution_status =
      // 'failed'` comes straight back round on the next sweep and is therefore
      // still in flight, not over. Only `executed_at` with an error recorded
      // beside it means nothing further will be tried.
      status: row.executedAt !== null && row.executionError !== null ? 'failed' : row.status,
      decisionNote: row.decisionNote,
      failureReason: row.executedAt !== null ? row.executionError : null,
      continuationPending:
        (row.status === 'approved' || row.status === 'rejected') && row.executedAt === null,
      createdAt: row.createdAt.toISOString(),
    }
  })
}
