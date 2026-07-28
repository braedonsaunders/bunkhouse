import Link from 'next/link'
import { desc, eq, sql } from 'drizzle-orm'
import { Badge, Button, EmptyState } from '@appkit/ui'
import { approvals, people, runs, tokenSpend } from '../db/schema'
import { db } from '../db/client'
import { resolveTenantId } from '../lib/tenant'
import { Lobby, type LobbyPerson } from '../components/lobby'
import { listAvatarCompositions, loadAvatarPartLibrary } from '../lib/avatars'
import { AVATAR_PART_CATEGORIES } from '../lib/avatar-parts'

export const dynamic = 'force-dynamic'

/**
 * The home screen is the floor: the agents on staff at work in a drawn office
 * environment, edge to edge, with the dashboard floating over it — title and
 * actions up top, the numbers that matter beneath them, and a compact run feed
 * in the corner. It fits the viewport exactly; only the run feed scrolls,
 * internally.
 */
export default async function HomePage() {
  const tenantId = await resolveTenantId()
  const app = db()

  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)

  const data = await app.withTenantContext(tenantId, async () => {
    const [counts] = await app.db
      .select({
        agents: sql<number>`count(*) filter (where ${people.kind} = 'agent' and ${people.status} = 'active')`.mapWith(Number),
        onboarding: sql<number>`count(*) filter (where ${people.kind} = 'agent' and ${people.status} = 'onboarding')`.mapWith(Number),
      })
      .from(people)
    const [pending] = await app.db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(approvals)
      .where(eq(approvals.status, 'pending'))
    const [working] = await app.db
      .select({ count: sql<number>`count(distinct ${runs.personId})`.mapWith(Number) })
      .from(runs)
      .where(eq(runs.status, 'running'))
    const [payroll] = await app.db
      .select({ cost: sql<string>`coalesce(sum(${tokenSpend.costUsd}), 0)` })
      .from(tokenSpend)
      .where(sql`${tokenSpend.createdAt} >= ${monthStart}`)
    const recentRuns = await app.db
      .select({
        id: runs.id,
        personId: runs.personId,
        status: runs.status,
        summary: runs.summary,
        startedAt: runs.startedAt,
        personName: people.name,
      })
      .from(runs)
      .innerJoin(people, eq(people.id, runs.personId))
      .orderBy(desc(runs.startedAt))
      .limit(20)
    const agents = await app.db
      .select({ id: people.id, name: people.name, title: people.title })
      .from(people)
      .where(sql`${people.kind} = 'agent' and ${people.status} = 'active'`)
    const busyIds = await app.db
      .select({ personId: runs.personId })
      .from(runs)
      .where(eq(runs.status, 'running'))
    return {
      counts: counts!,
      pending: pending?.count ?? 0,
      working: working?.count ?? 0,
      payroll: Number(payroll?.cost ?? 0),
      recentRuns,
      agents,
      busyIds,
    }
  })

  // The floor is agents only — the people on staff manage it, they don't live
  // in it. Each figure is the composition the directory crops for portraits.
  const [compositions, partLibrary] = await Promise.all([
    listAvatarCompositions(tenantId),
    loadAvatarPartLibrary(tenantId),
  ])
  const busy = new Set(data.busyIds.map((r) => r.personId))
  const lobby: LobbyPerson[] = data.agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    ...(compositions.has(agent.id) ? { composition: compositions.get(agent.id)! } : {}),
    status: busy.has(agent.id)
      ? { label: 'working', tone: 'busy' as const }
      : { label: agent.title, tone: 'active' as const },
    idleAnimation: 'bounce' as const,
  }))

  const stats: { label: string; value: string; href: string }[] = [
    { label: 'Agents on staff', value: String(data.counts.agents), href: '/organization/agents' },
    { label: 'Working right now', value: String(data.working), href: '/observatory' },
    { label: 'Pending approvals', value: String(data.pending), href: '/approvals' },
    { label: 'Payroll this month', value: `$${data.payroll.toFixed(2)}`, href: '/organization/agents' },
  ]

  // Widgets float over the scene; the wrapper is pointer-transparent so the
  // floor stays clickable between them, and each widget opts back in.
  const widgets = (
    <div className="flex h-full min-h-0 flex-col gap-3 p-5">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3">
        <div className="pointer-events-auto rounded-lg border border-border bg-surface/85 px-4 py-3 shadow-sm backdrop-blur">
          <h1 className="text-xl font-semibold tracking-tight">Bunkhouse</h1>
          <p className="text-sm text-fg-muted">Where your agents live. Put them to work, look in any time.</p>
        </div>
        <div className="pointer-events-auto flex items-center gap-2">
          <Button asChild variant="outline" size="sm" className="bg-surface/85 backdrop-blur">
            <Link href="/observatory">Observatory</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/roles">Onboard an agent</Link>
          </Button>
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-4 lg:max-w-3xl">
        {stats.map((stat) => (
          <Link
            key={stat.label}
            href={stat.href}
            className="pointer-events-auto rounded-lg border border-border bg-surface/85 p-3 shadow-sm backdrop-blur transition-colors hover:border-primary"
          >
            <p className="text-2xl font-semibold tabular-nums">{stat.value}</p>
            <p className="text-xs text-fg-muted">{stat.label}</p>
          </Link>
        ))}
      </div>

      {data.counts.onboarding > 0 ? (
        <p className="pointer-events-auto w-fit shrink-0 rounded-md border border-border bg-surface/85 px-3 py-1.5 text-xs text-fg-muted shadow-sm backdrop-blur">
          {data.counts.onboarding} agent{data.counts.onboarding === 1 ? '' : 's'} still onboarding —{' '}
          <Link href="/organization/agents" className="text-primary hover:underline">
            finish setting them up
          </Link>
          .
        </p>
      ) : null}

      {/* The run feed, tucked into the lower-left corner. */}
      <div className="pointer-events-auto mt-auto flex min-h-0 max-h-[46%] w-full max-w-sm flex-col rounded-lg border border-border bg-surface/85 shadow-sm backdrop-blur">
        <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
          <h2 className="text-sm font-semibold">Recent work</h2>
          <Button asChild variant="ghost" size="sm">
            <Link href="/observatory">Observatory</Link>
          </Button>
        </div>
        <div className="app-scroll min-h-0 flex-1 overflow-y-auto p-2">
          {data.recentRuns.length === 0 ? (
            <p className="p-2 text-xs text-fg-muted">
              Once an agent has a mailbox and duties, their work shows up here.
            </p>
          ) : (
            <div className="space-y-1.5">
              {data.recentRuns.map((run) => (
                <div
                  key={run.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border/70 px-2.5 py-1.5 text-xs"
                >
                  <div className="min-w-0">
                    <Link href={`/runs/${run.id}`} className="font-medium hover:text-primary">
                      {run.personName}
                    </Link>
                    <p className="truncate text-fg-muted">{run.summary ?? 'Working…'}</p>
                  </div>
                  <Badge variant={run.status === 'completed' ? 'default' : 'outline'}>{run.status}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )

  if (lobby.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          title="Nobody lives here yet"
          description="Onboard your first agent and they will show up on the floor."
          action={
            <Button asChild>
              <Link href="/roles">Onboard an agent</Link>
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className="h-full min-h-0">
      <Lobby people={lobby} parts={partLibrary} categories={AVATAR_PART_CATEGORIES}>
        {widgets}
      </Lobby>
    </div>
  )
}
