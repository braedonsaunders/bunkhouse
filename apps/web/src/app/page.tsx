import Link from 'next/link'
import { desc, eq, sql } from 'drizzle-orm'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageContainer,
  PageHeader,
} from '@appkit/ui'
import { approvals, people, runs } from '../db/schema'
import { db } from '../db/client'
import { resolveTenantId } from '../lib/tenant'
import { Lobby, type LobbyPerson } from '../components/lobby'
import { listAvatarCompositions, loadAvatarPartLibrary } from '../lib/avatars'
import { AVATAR_PART_CATEGORIES } from '../lib/avatar-parts'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const tenantId = await resolveTenantId()
  const app = db()

  const data = await app.withTenantContext(tenantId, async () => {
    const [counts] = await app.db
      .select({
        agents: sql<number>`count(*) filter (where ${people.kind} = 'agent')`.mapWith(Number),
        humans: sql<number>`count(*) filter (where ${people.kind} = 'human')`.mapWith(Number),
        onboarding: sql<number>`count(*) filter (where ${people.status} = 'onboarding')`.mapWith(Number),
      })
      .from(people)
    const [pending] = await app.db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(approvals)
      .where(eq(approvals.status, 'pending'))
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
      .limit(8)
    const roster = await app.db
      .select({ id: people.id, name: people.name, kind: people.kind, title: people.title })
      .from(people)
      .where(eq(people.status, 'active'))
    const busyIds = await app.db
      .select({ personId: runs.personId })
      .from(runs)
      .where(eq(runs.status, 'running'))
    return { counts: counts!, pending: pending?.count ?? 0, recentRuns, roster, busyIds }
  })

  // The floor: everyone active, walking as the figure they were composed as.
  // The same composition the directory crops for a portrait — one document.
  const [compositions, partLibrary] = await Promise.all([
    listAvatarCompositions(tenantId),
    loadAvatarPartLibrary(tenantId),
  ])
  const busy = new Set(data.busyIds.map((r) => r.personId))
  const lobby: LobbyPerson[] = data.roster.map((person) => ({
    id: person.id,
    name: person.name,
    ...(compositions.has(person.id) ? { composition: compositions.get(person.id)! } : {}),
    status: busy.has(person.id)
      ? { label: 'working', tone: 'busy' as const }
      : { label: person.title, tone: person.kind === 'agent' ? ('active' as const) : ('idle' as const) },
    idleAnimation: person.kind === 'agent' ? ('bounce' as const) : ('sway' as const),
  }))

  return (
    <PageContainer className="space-y-6">
      <Lobby people={lobby} parts={partLibrary} categories={AVATAR_PART_CATEGORIES}>
        <div className="p-6">
          <PageHeader
            title="Bunkhouse"
            description="Where your agents live. Put them to work, look in any time."
            actions={
              <div className="flex items-center gap-2">
                <Button asChild variant="outline">
                  <Link href="/observatory">Observatory</Link>
                </Button>
                <Button asChild>
                  <Link href="/roles">Onboard an agent</Link>
                </Button>
              </div>
            }
          />
        </div>
      </Lobby>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Organization</CardTitle>
            <CardDescription>People and agents, one reporting hierarchy.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>
              <span className="text-2xl font-semibold">{data.counts.agents}</span>{' '}
              <span className="text-fg-muted">agents</span> ·{' '}
              <span className="text-2xl font-semibold">{data.counts.humans}</span>{' '}
              <span className="text-fg-muted">people</span>
            </p>
            {data.counts.onboarding > 0 ? (
              <p className="text-fg-muted">{data.counts.onboarding} onboarding</p>
            ) : null}
            <Button asChild variant="outline" className="mt-2">
              <Link href="/organization/chart">Open the org chart</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Approvals</CardTitle>
            <CardDescription>Actions waiting on human sign-off.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <span className="text-2xl font-semibold">{data.pending}</span>{' '}
              <span className="text-fg-muted">pending</span>
            </p>
            <Button asChild variant="outline">
              <Link href="/approvals">Review queue</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Getting set up</CardTitle>
            <CardDescription>What a new bunkhouse needs.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 text-sm text-fg-muted">
            <p>1. Add the people on staff to your organization.</p>
            <p>2. Onboard an agent from a role.</p>
            <p>3. Connect their mailbox and give them a voice.</p>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Recent work</CardTitle>
          <CardDescription>The latest runs across every agent.</CardDescription>
        </CardHeader>
        <CardContent>
          {data.recentRuns.length === 0 ? (
            <EmptyState
              title="No runs yet"
              description="Once an agent has a mailbox and duties, their work shows up here and in the observatory."
            />
          ) : (
            <div className="space-y-2">
              {data.recentRuns.map((run) => (
                <div key={run.id} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
                  <div>
                    <Link href={`/runs/${run.id}`} className="font-medium hover:text-primary">
                      {run.personName}
                    </Link>
                    <p className="text-fg-muted">{run.summary ?? 'Working…'}</p>
                  </div>
                  <Badge variant={run.status === 'completed' ? 'default' : 'outline'}>{run.status}</Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  )
}
