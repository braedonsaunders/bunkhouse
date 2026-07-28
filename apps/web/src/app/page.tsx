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
 * The home screen is a split cockpit: the working half — counts, the approval
 * queue, the live run feed — beside the floor, where the agents on staff walk
 * one of the painted stages. It fits the viewport exactly; only the run feed
 * scrolls, internally.
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
      .limit(30)
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
    {
      label: 'Payroll this month',
      value: `$${data.payroll.toFixed(2)}`,
      href: '/organization/agents',
    },
  ]

  return (
    <div className="flex h-full min-h-0">
      {/* The working half. */}
      <div className="flex h-full min-h-0 w-1/2 flex-col gap-4 overflow-hidden p-6">
        <div className="flex shrink-0 flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Bunkhouse</h1>
            <p className="text-sm text-fg-muted">
              Where your agents live. Put them to work, look in any time.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/observatory">Observatory</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/roles">Onboard an agent</Link>
            </Button>
          </div>
        </div>

        <div className="grid shrink-0 grid-cols-2 gap-3 xl:grid-cols-4">
          {stats.map((stat) => (
            <Link
              key={stat.label}
              href={stat.href}
              className="rounded-lg border border-border bg-surface p-3 transition-colors hover:border-primary"
            >
              <p className="text-2xl font-semibold tabular-nums">{stat.value}</p>
              <p className="text-xs text-fg-muted">{stat.label}</p>
            </Link>
          ))}
        </div>

        {data.counts.onboarding > 0 ? (
          <p className="shrink-0 text-xs text-fg-muted">
            {data.counts.onboarding} agent{data.counts.onboarding === 1 ? '' : 's'} still onboarding —{' '}
            <Link href="/organization/agents" className="text-primary hover:underline">
              finish setting them up
            </Link>
            .
          </p>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-surface">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">Recent work</h2>
              <p className="text-xs text-fg-muted">The latest runs across every agent.</p>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link href="/observatory">Open the observatory</Link>
            </Button>
          </div>
          <div className="app-scroll min-h-0 flex-1 overflow-y-auto p-3">
            {data.recentRuns.length === 0 ? (
              <EmptyState
                title="No runs yet"
                description="Once an agent has a mailbox and duties, their work shows up here and in the observatory."
              />
            ) : (
              <div className="space-y-2">
                {data.recentRuns.map((run) => (
                  <div
                    key={run.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm"
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

      {/* The floor. */}
      <div className="relative h-full min-h-0 w-1/2 border-l border-border">
        {lobby.length === 0 ? (
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
        ) : (
          <Lobby people={lobby} parts={partLibrary} categories={AVATAR_PART_CATEGORIES} />
        )}
      </div>
    </div>
  )
}
