import { desc, eq, sql } from 'drizzle-orm'
import { PageContainer, PageHeader } from '@appkit/ui'
import { avatarImages, callSessions, people, runs, tokenSpend } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId } from '../../lib/tenant'
import { ObservatoryList, type ObservatoryRunRow } from '../../components/observatory-list'
import { LiveToggle } from '../../components/live-toggle'

export const dynamic = 'force-dynamic'

const TRIGGER_LABELS: Record<string, string> = {
  email: 'Inbound email',
  duty: 'Scheduled duty',
  chat: 'Chat',
  delegation: 'Delegated task',
  manual: 'Manual',
}

const STATUS_LABELS: Record<string, string> = {
  running: 'running',
  waiting_approval: 'waiting approval',
  waiting_reply: 'waiting reply',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
}

export default async function ObservatoryPage() {
  const tenantId = await resolveTenantId()
  const app = db()

  const data = await app.withTenantContext(tenantId, async () => {
    const runRows = await app.db
      .select({
        id: runs.id,
        personId: runs.personId,
        status: runs.status,
        trigger: runs.trigger,
        summary: runs.summary,
        startedAt: runs.startedAt,
        personName: people.name,
        personTitle: people.title,
      })
      .from(runs)
      .innerJoin(people, eq(people.id, runs.personId))
      .orderBy(desc(runs.startedAt))
      .limit(200)
    const spendRows = await app.db
      .select({
        runId: tokenSpend.runId,
        cost: sql<string>`coalesce(sum(${tokenSpend.costUsd}), 0)`,
      })
      .from(tokenSpend)
      .groupBy(tokenSpend.runId)
    const avatarRows = await app.db.select({ personId: avatarImages.personId }).from(avatarImages)
    // Phone calls run under a call session; the direction distinguishes an
    // inbound ring from an in-app conversation.
    const inboundCallRows = await app.db
      .select({ runId: callSessions.runId })
      .from(callSessions)
      .where(eq(callSessions.direction, 'inbound_phone'))
    return { runRows, spendRows, avatarRows, inboundCallRows }
  })

  const costByRun = new Map(data.spendRows.map((s) => [s.runId, Number(s.cost)]))
  const hasAvatar = new Set(data.avatarRows.map((a) => a.personId))
  const inboundCallRuns = new Set(data.inboundCallRows.map((s) => s.runId))
  const rows: ObservatoryRunRow[] = data.runRows.map((run) => ({
    id: run.id,
    hand: run.personName,
    handTitle: run.personTitle,
    ...(hasAvatar.has(run.personId) ? { avatarSrc: `/api/avatars/${run.personId}` } : {}),
    trigger: inboundCallRuns.has(run.id) ? 'Inbound call' : (TRIGGER_LABELS[String(run.trigger.type)] ?? 'Manual'),
    status: run.status,
    statusLabel: STATUS_LABELS[run.status] ?? run.status,
    summary: run.summary ?? 'Working…',
    started: run.startedAt.toISOString().slice(0, 16).replace('T', ' '),
    startedAt: run.startedAt.toISOString(),
    cost: `$${(costByRun.get(run.id) ?? 0).toFixed(4)}`,
  }))

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Observatory"
        description="Watch a hand work — every run across the company, and what's on their screen right now."
        actions={<LiveToggle />}
      />
      <ObservatoryList rows={rows} />
    </PageContainer>
  )
}
