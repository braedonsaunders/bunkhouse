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
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  decisionNote: string | null
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
      status: row.status,
      decisionNote: row.decisionNote,
      createdAt: row.createdAt.toISOString(),
    }
  })
}
