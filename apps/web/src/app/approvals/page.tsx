import { asc, desc, eq, ne } from 'drizzle-orm'
import { PageContainer, PageHeader } from '@appkit/ui'
import { approvals, people, type ApprovalPayload } from '../../db/schema'
import { db } from '../../db/client'
import { requireTenantPermission } from '../../lib/tenant'
import { ApprovalsView, type ApprovalDraft, type ApprovalRow } from '../../components/approvals-view'

export const dynamic = 'force-dynamic'

const stamp = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ')

/** `external_email` is what the enum stores; "External email" is what it means. */
const categoryLabel = (category: string) => {
  const words = category.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The exact wording an approver is signing off on. Approving an external email
 * without reading it is not approval, so the queued action's own arguments are
 * shown verbatim: the addressee and subject as labelled fields, and the body —
 * or the shell command, or the page being opened — as the reviewable text.
 */
function draftOf(payload: unknown): ApprovalDraft {
  const action = (payload as { action?: { input?: Record<string, unknown> } } | null)?.action
  const input = action?.input ?? {}
  const str = (key: string): string | null => {
    const value = input[key]
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }
  const fields: { label: string; value: string }[] = []
  const to = str('to')
  const subject = str('subject')
  const cwd = str('cwd')
  if (to) fields.push({ label: 'To', value: to })
  if (subject) fields.push({ label: 'Subject', value: subject })
  if (cwd) fields.push({ label: 'Working directory', value: cwd })
  return { fields, text: str('body') ?? str('command') ?? str('url') ?? str('target') }
}

const COLUMNS = {
  id: approvals.id,
  runId: approvals.runId,
  category: approvals.category,
  payload: approvals.payload,
  status: approvals.status,
  createdAt: approvals.createdAt,
  decidedAt: approvals.decidedAt,
  decisionNote: approvals.decisionNote,
  personId: approvals.personId,
  personName: people.name,
  personTitle: people.title,
}

type QueryRow = {
  id: string
  runId: string
  category: string
  payload: ApprovalPayload
  status: ApprovalRow['status']
  createdAt: Date
  decidedAt: Date | null
  decisionNote: string | null
  personId: string
  personName: string
  personTitle: string
}

const toRow = (row: QueryRow): ApprovalRow => ({
  id: row.id,
  runId: row.runId,
  personId: row.personId,
  personName: row.personName,
  personTitle: row.personTitle,
  category: row.category,
  categoryLabel: categoryLabel(row.category),
  description: row.payload.description,
  draft: draftOf(row.payload),
  createdAt: stamp(row.createdAt),
  status: row.status,
  decidedAt: row.decidedAt ? stamp(row.decidedAt) : null,
  decisionNote: row.decisionNote,
})

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams
  // The access object, not just the tenant id: whether this member may decide
  // is what tells the queue to offer buttons or only the request.
  const access = await requireTenantPermission('approvals.read')
  const app = db()
  // Two queries, not one sliced in half: the queue is oldest-first because the
  // longest wait is the most overdue, the history is newest-first, and neither
  // half may be truncated by how busy the other one is.
  const { pending, decided } = await app.withTenantContext(access.tenantId, async () => {
    const base = () => app.db.select(COLUMNS).from(approvals).innerJoin(people, eq(people.id, approvals.personId))
    return {
      pending: await base().where(eq(approvals.status, 'pending')).orderBy(asc(approvals.createdAt)).limit(500),
      decided: await base()
        .where(ne(approvals.status, 'pending'))
        .orderBy(desc(approvals.decidedAt), desc(approvals.createdAt))
        .limit(500),
    }
  })

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Approvals"
        description="Actions your agents queued for human sign-off. Approve, or decline with a note they learn from."
      />
      <ApprovalsView
        pending={pending.map(toRow)}
        decided={decided.map(toRow)}
        canDecide={access.user.isSuperAdmin || access.permissions.has('approvals.decide')}
        {...(tab ? { initialTab: tab } : {})}
      />
    </PageContainer>
  )
}
