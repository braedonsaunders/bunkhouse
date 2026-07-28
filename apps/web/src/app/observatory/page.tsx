import { desc, eq, inArray, sql } from 'drizzle-orm'
import { PageContainer, PageHeader } from '@appkit/ui'
import { callSessions, people, runs, runEvents, tokenSpend } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId } from '../../lib/tenant'
import { type ObservatoryRunRow } from '../../components/observatory-list'
import { ObservatoryFloor, type ActiveRunCardRow } from '../../components/observatory-floor'
import { LiveToggle } from '../../components/live-toggle'
import { RosterAvatar } from '../../components/roster-avatar'
import { describeToolCall } from '../../lib/call-activity'
import { listAvatarCompositions, loadAvatarPartLibrary } from '../../lib/avatars'
import { AVATAR_PART_CATEGORIES } from '../../lib/avatar-parts'

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

const ACTIVE_STATUSES = ['running', 'waiting_approval', 'waiting_reply'] as const
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'] as const

const snippet = (value: unknown, max = 80): string | null => {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  if (!text) return null
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The card's "now" line: the newest ledger event, phrased as an activity. */
function describeLatestEvent(kind: string, payload: Record<string, unknown>): string | null {
  switch (kind) {
    case 'tool_call':
      return describeToolCall(String(payload.toolName ?? ''), payload.input)
    case 'tool_result': {
      const name = snippet(payload.toolName)
      return name ? `Reviewing ${name.replace(/[_-]+/g, ' ')} results` : 'Reviewing results'
    }
    case 'thought': {
      const text = snippet(payload.text)
      return text ? `Thinking — ${text}` : 'Thinking…'
    }
    case 'message': {
      const text = snippet(payload.text)
      return text ? `“${text}”` : 'Writing a reply'
    }
    case 'procedure_citation':
      return `Consulting ${String(payload.slug ?? 'a procedure')} v${String(payload.version ?? '?')}`
    case 'approval_request': {
      const text = snippet(payload.description)
      return text ? `Waiting for sign-off — ${text}` : 'Waiting for sign-off'
    }
    case 'delegation':
      return 'Delegating work to a colleague'
    case 'error': {
      const text = snippet(payload.message)
      return text ? `Hit an error — ${text}` : 'Hit an error'
    }
    default:
      return null
  }
}

export default async function ObservatoryPage() {
  const tenantId = await resolveTenantId()
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
    const latestEvents = activeRuns.length
      ? await app.db
          .selectDistinctOn([runEvents.runId], {
            runId: runEvents.runId,
            kind: runEvents.kind,
            payload: runEvents.payload,
          })
          .from(runEvents)
          .where(
            inArray(
              runEvents.runId,
              activeRuns.map((r) => r.id),
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
    inboundCallRuns.has(run.id) ? 'Inbound call' : (TRIGGER_LABELS[String(run.trigger.type)] ?? 'Manual')
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
        actions={<LiveToggle defaultOn />}
      />
      <ObservatoryFloor active={active} history={history} renderedAt={new Date().toISOString()} />
    </PageContainer>
  )
}
