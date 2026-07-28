import Link from 'next/link'
import { desc, eq } from 'drizzle-orm'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  PageContainer,
  PageHeader,
} from '@appkit/ui'
import { approvals, people } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId } from '../../lib/tenant'
import { approveAction, rejectAction } from './actions'

export const dynamic = 'force-dynamic'

export default async function ApprovalsPage() {
  const tenantId = await resolveTenantId()
  const app = db()
  const rows = await app.withTenantContext(tenantId, () =>
    app.db
      .select({
        id: approvals.id,
        category: approvals.category,
        payload: approvals.payload,
        status: approvals.status,
        createdAt: approvals.createdAt,
        decidedAt: approvals.decidedAt,
        decisionNote: approvals.decisionNote,
        personId: approvals.personId,
        personName: people.name,
        personTitle: people.title,
      })
      .from(approvals)
      .innerJoin(people, eq(people.id, approvals.personId))
      .orderBy(desc(approvals.createdAt))
      .limit(50),
  )
  const pending = rows.filter((r) => r.status === 'pending')
  const decided = rows.filter((r) => r.status !== 'pending')

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Approvals"
        description="Actions your agents queued for human sign-off. Approve, or decline with a note they learn from."
      />
      {pending.length === 0 ? (
        <EmptyState title="Queue is clear" description="Nothing is waiting on you." />
      ) : (
        pending.map((row) => (
          <Card key={row.id}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2 text-base">
                <span>
                  <Link href={`/organization/agents?person=${row.personId}`} className="hover:text-primary">
                    {row.personName}
                  </Link>{' '}
                  <span className="text-fg-muted">· {row.personTitle}</span>
                </span>
                <Badge variant="outline">{row.category}</Badge>
              </CardTitle>
              <CardDescription>{row.createdAt.toISOString().slice(0, 16).replace('T', ' ')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p>{row.payload.description}</p>
              <form className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="approvalId" value={row.id} />
                <Input name="note" placeholder="Optional note back to the agent" className="max-w-sm" />
                <Button formAction={approveAction}>Approve</Button>
                <Button formAction={rejectAction} variant="outline">
                  Decline
                </Button>
              </form>
            </CardContent>
          </Card>
        ))
      )}
      {decided.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Recently decided</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {decided.slice(0, 10).map((row) => (
              <div key={row.id} className="flex items-center justify-between rounded-md border border-border p-3">
                <div>
                  <p className="font-medium">
                    {row.personName} · {row.payload.description}
                  </p>
                  {row.decisionNote ? <p className="text-fg-muted">Note: {row.decisionNote}</p> : null}
                </div>
                <Badge variant={row.status === 'approved' ? 'default' : 'destructive'}>{row.status}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </PageContainer>
  )
}
