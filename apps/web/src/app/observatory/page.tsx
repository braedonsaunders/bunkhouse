import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { PageContainer, PageHeader } from '@braedonsaunders/appkit-ui'
import { callSessions, people, runs, runEvents, tokenSpend } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId } from '../../lib/tenant'
import { type ObservatoryRunRow } from '../../components/observatory-list'
import { ObservatoryFloor, type ActiveRunCardRow } from '../../components/observatory-floor'
import { RosterAvatar } from '../../components/roster-avatar'
import { describeLatestEvent } from '../../lib/scene-activity'
import { listAvatarCompositions, loadAvatarPartLibrary } from '../../lib/avatars'
import { AVATAR_PART_CATEGORIES } from '../../lib/avatar-parts'
import { runDrawer } from '../runs/run-record'

export const dynamic = 'force-dynamic'

const BASE_PATH = '/observatory'

/**
 * Every trigger there is. Two were missing — `assignment` and
 * `approval_followup` — and the fallback below said "Manual", so a screen full
 * of colleagues handing each other work read as a screen full of things
 * somebody had started by hand. Nothing in the system files a manual run at
 * all, which is what made it confusing rather than merely wrong.
 */
const TRIGGER_LABELS: Record<string, string> = {
  email: 'Inbound email',
  duty: 'Scheduled duty',
  chat: 'Chat',
  delegation: 'Delegated task',
  assignment: 'Assignment',
  approval_followup: 'After an approval',
  manual: 'Started by hand',
}

const STATUS_LABELS: Record<string, string> = {
  running: 'running',
  waiting_approval: 'waiting approval',
  waiting_reply: 'waiting reply',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
}

const ACTIVE_STATUSES = ['running', 'waiting_approval', 'waiting_reply'] as const
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'] as const



export default async function ObservatoryPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string; tab?: string }>
}) {
  const { run: selectedRunId, tab } = await searchParams
  const tenantId = await resolveTenantId('observatory.read')
  const app = db()

  const data = await app.withTenantContext(tenantId, async () => {
    // Every run in flight gets a card — no limit, the floor is never paged.
    const activeRuns = await app.db
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
      .where(inArray(runs.status, [...ACTIVE_STATUSES]))
      .orderBy(desc(runs.startedAt))
    const historyRuns = await app.db
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
      .where(inArray(runs.status, [...FINISHED_STATUSES]))
      .orderBy(desc(runs.startedAt))
      .limit(200)
    const allIds = [...activeRuns, ...historyRuns].map((r) => r.id)
    const spendRows = allIds.length
      ? await app.db
          .select({
            runId: tokenSpend.runId,
            cost: sql<string>`coalesce(sum(${tokenSpend.costUsd}), 0)`,
          })
          .from(tokenSpend)
          .where(inArray(tokenSpend.runId, allIds))
          .groupBy(tokenSpend.runId)
      : []
    // Each live card shows the newest ledger entry — what's on the screen now.
    // Trace events are excluded on purpose: they are the operational record of
    // why the agent did something, not something it did, and being the newest
    // row far more often than any tool call they would replace "Reading
    // example.com" with instrumentation on every card.
    const latestEvents = activeRuns.length
      ? await app.db
          .selectDistinctOn([runEvents.runId], {
            runId: runEvents.runId,
            kind: runEvents.kind,
            payload: runEvents.payload,
          })
          .from(runEvents)
          .where(
            and(
              inArray(
                runEvents.runId,
                activeRuns.map((r) => r.id),
              ),
              ne(runEvents.kind, 'trace'),
            ),
          )
          .orderBy(runEvents.runId, desc(runEvents.seq))
      : []
    // Phone calls run under a call session; the direction distinguishes an
    // inbound ring from an in-app conversation.
    const inboundCallRows = await app.db
      .select({ runId: callSessions.runId })
      .from(callSessions)
      .where(eq(callSessions.direction, 'inbound_phone'))
    return { activeRuns, historyRuns, spendRows, latestEvents, inboundCallRows }
  })

  // Faces on the floor are the head crop of each agent's one figure.
  const [compositions, partLibrary] = await Promise.all([
    listAvatarCompositions(tenantId),
    loadAvatarPartLibrary(tenantId),
  ])

  const costByRun = new Map(data.spendRows.map((s) => [s.runId, Number(s.cost)]))
  const nowByRun = new Map(data.latestEvents.map((e) => [e.runId, describeLatestEvent(e.kind, e.payload)]))
  const inboundCallRuns = new Set(data.inboundCallRows.map((s) => s.runId))
  const triggerOf = (run: (typeof data.activeRuns)[number]) =>
    inboundCallRuns.has(run.id) ? 'Inbound call' : (TRIGGER_LABELS[String(run.trigger.type)] ?? String(run.trigger.type))
  const avatarOf = (run: (typeof data.activeRuns)[number], size: number) => (
    <RosterAvatar
      name={run.personName}
      composition={compositions.get(run.personId) ?? null}
      parts={partLibrary}
      categories={AVATAR_PART_CATEGORIES}
      size={size}
    />
  )

  const active: ActiveRunCardRow[] = data.activeRuns.map((run) => ({
    id: run.id,
    agent: run.personName,
    agentTitle: run.personTitle,
    avatar: avatarOf(run, 48),
    trigger: triggerOf(run),
    status: run.status as ActiveRunCardRow['status'],
    statusLabel: STATUS_LABELS[run.status] ?? run.status,
    summary: run.summary ?? 'Working…',
    now: nowByRun.get(run.id) ?? null,
    startedAt: run.startedAt.toISOString(),
    cost: `$${(costByRun.get(run.id) ?? 0).toFixed(4)}`,
  }))

  const history: ObservatoryRunRow[] = data.historyRuns.map((run) => {
    const costUsd = costByRun.get(run.id) ?? 0
    return {
      id: run.id,
      agent: run.personName,
      agentTitle: run.personTitle,
      avatar: avatarOf(run, 26),
      trigger: triggerOf(run),
      status: run.status,
      statusLabel: STATUS_LABELS[run.status] ?? run.status,
      summary: run.summary ?? 'Working…',
      started: run.startedAt.toISOString().slice(0, 16).replace('T', ' '),
      startedAt: run.startedAt.toISOString(),
      cost: `$${costUsd.toFixed(4)}`,
      costUsd,
    }
  })

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Observatory"
        description="Watch an agent work — every run across the company, and what's on their screen right now."
      />
      <ObservatoryFloor
        active={active}
        history={history}
        renderedAt={new Date().toISOString()}
        basePath={BASE_PATH}
        recordOpen={Boolean(selectedRunId)}
      />
      {await runDrawer({ tenantId, runId: selectedRunId, basePath: BASE_PATH, tab })}
    </PageContainer>
  )
}
