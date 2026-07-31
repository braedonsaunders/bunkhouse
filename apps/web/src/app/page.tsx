import Link from 'next/link'
import { asc, eq, sql } from 'drizzle-orm'
import { Button, EmptyState } from '@appkit/ui'
import { approvals, people, runs, tokenSpend } from '../db/schema'
import { db } from '../db/client'
import { resolveTenantId } from '../lib/tenant'
import { Lobby, type LobbyPerson } from '../components/lobby'
import { describeLatestEvent, sceneStatus } from '../lib/scene-activity'
import { listDepartments, wanderingEnabled } from '../lib/departments'
import { peopleInDepartment } from '../lib/whereabouts'
import type { SceneKind } from '../components/scene-kinds'
import { listAvatarCompositions, loadAvatarPartLibrary } from '../lib/avatars'
import { AVATAR_PART_CATEGORIES } from '../lib/avatar-parts'
import { personDrawer } from './organization/person-record'

export const dynamic = 'force-dynamic'

/**
 * The home screen is the floor: the agents on staff at work in a drawn office
 * environment, edge to edge, with one band of dashboard floating over it —
 * the KPIs and the two actions, nothing else. Clicking a figure opens their
 * record right here, over the floor; the page never changes beneath it.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ person?: string; dept?: string }>
}) {
  const params = await searchParams
  const selectedId = params.person
  const tenantId = await resolveTenantId()
  const app = db()

  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)

  const data = await app.withTenantContext(tenantId, async () => {
    const roster = await app.db.select().from(people).orderBy(asc(people.name))
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
    // Not just WHO is busy but WHAT they are doing — the newest thing on each
    // running agent's ledger, and the last thing it said. A floor of figures
    // strolling about conveys that the office is populated and nothing at all
    // about whether anybody is working, which is the only reason to open it.
    const busy = await app.db.execute(sql`
      select distinct on (r.person_id)
             r.person_id            as "personId",
             r.status               as "runStatus",
             e.kind                 as "eventKind",
             e.payload              as "eventPayload",
             (
               select m.payload ->> 'text' from run_events m
               where m.run_id = r.id and m.kind = 'message' and m.payload ->> 'text' <> ''
               order by m.seq desc limit 1
             )                      as "saying"
        from runs r
        left join lateral (
          select kind, payload from run_events
          where run_id = r.id order by seq desc limit 1
        ) e on true
       where r.status in ('running', 'waiting_approval')
       order by r.person_id, r.started_at desc
    `)
    const busyIds = busy.rows as {
      personId: string
      runStatus: string
      eventKind: string | null
      eventPayload: Record<string, unknown> | null
      saying: string | null
    }[]
    return {
      roster,
      pending: pending?.count ?? 0,
      working: working?.count ?? 0,
      payroll: Number(payroll?.cost ?? 0),
      busyIds,
    }
  })

  const agents = data.roster.filter((p) => p.kind === 'agent' && p.status === 'active')
  const onboarding = data.roster.filter((p) => p.kind === 'agent' && p.status === 'onboarding').length

  // The floor is agents only — the people on staff manage it, they don't live
  // in it. Each figure is the composition the directory crops for portraits.
  const [compositions, partLibrary] = await Promise.all([
    listAvatarCompositions(tenantId),
    loadAvatarPartLibrary(tenantId),
  ])
  // The company's places, and whether anybody wanders between them today.
  const [places, wander] = await Promise.all([listDepartments(tenantId), wanderingEnabled(tenantId)])
  const departmentSlug = typeof params.dept === 'string' ? params.dept : (places[0]?.slug ?? '')
  const viewing = places.find((place) => place.slug === departmentSlug) ?? places[0] ?? null

  const busy = new Map(data.busyIds.map((row) => [row.personId, row]))
  // Who is on this floor at this moment — home department, plus whoever has
  // wandered in. Stable within a slot, so the crowd does not reshuffle on
  // every re-render (see lib/whereabouts.ts).
  const present = viewing
    ? peopleInDepartment({
        people: agents.map((agent) => ({ ...agent, departmentId: agent.departmentId ?? null })),
        departmentId: viewing.id,
        departmentIds: places.map((place) => place.id),
        now: new Date(),
        wander,
      })
    : agents.map((agent) => ({ ...agent, visiting: false }))

  const lobby: LobbyPerson[] = present.map((agent) => {
    const now = busy.get(agent.id)
    const doing = now?.eventKind ? describeLatestEvent(now.eventKind, now.eventPayload ?? {}) : null
    return {
      id: agent.id,
      name: agent.name,
      title: agent.title,
      ...(agent.visiting ? { visiting: true } : {}),
      ...(compositions.has(agent.id) ? { composition: compositions.get(agent.id)! } : {}),
      // One word and a kind of motion. The sentence goes in the bubble.
      status: now
        ? sceneStatus({
            runStatus: now.runStatus,
            eventKind: now.eventKind,
            toolName: typeof now.eventPayload?.toolName === 'string' ? now.eventPayload.toolName : null,
          })
        : { label: 'free', tone: 'idle' as const, activity: 'idle' as const },
      // Its own working notes, as a thought bubble. Only while it is actually
      // running: a bubble left hanging over an idle figure reads as a stuck
      // agent, which is worse than no bubble at all.
      // Its own working note if it has one, otherwise what it is doing right
      // now — the sentence that used to be clipped into the pill.
      ...(now && now.runStatus === 'running' && (now.saying || doing)
        ? { speech: { text: (now.saying ?? doing ?? '').trim().slice(0, 220), kind: 'think' as const } }
        : {}),
      idleAnimation: 'bounce' as const,
    }
  })

  const stats: { label: string; value: string; href: string; alert?: boolean }[] = [
    { label: 'On staff', value: String(agents.length), href: '/organization' },
    { label: 'Working now', value: String(data.working), href: '/observatory' },
    { label: 'Approvals', value: String(data.pending), href: '/approvals', alert: data.pending > 0 },
    { label: 'Payroll', value: `$${data.payroll.toFixed(2)}`, href: '/organization' },
  ]

  // Widgets float over the scene; the wrapper is pointer-transparent so the
  // floor stays clickable between them, and each widget opts back in.
  //
  // Everything here is one HUD band across the top. A painted, animated floor
  // will eat a plain translucent card — so the panels carry their own light
  // (`.bh-hud` in globals.css) and there is only one row of them, kept shallow
  // so the room behind stays the thing you look at.
  const widgets = (
    <div className="flex h-full min-h-0 flex-col items-start gap-2.5 p-4 sm:p-5">
      <div className="flex w-full shrink-0 flex-wrap items-start justify-between gap-3">
        <div className="bh-hud pointer-events-auto flex divide-x divide-border/60 overflow-hidden rounded-2xl">
          {stats.map((stat) => (
            <Link
              key={stat.label}
              href={stat.href}
              className="min-w-0 px-4 py-2.5 transition-colors first:pl-5 last:pr-5 hover:bg-surface-hover/70"
            >
              <p
                className={`text-2xl font-semibold leading-none tabular-nums ${
                  stat.alert ? 'text-primary' : ''
                }`}
              >
                {stat.value}
              </p>
              <p className="mt-1.5 whitespace-nowrap text-[11px] font-medium uppercase tracking-wide text-fg-muted">
                {stat.label}
              </p>
            </Link>
          ))}
        </div>

        <div className="bh-hud pointer-events-auto flex items-center gap-1 rounded-full p-1">
          <Link
            href="/observatory"
            className="rounded-full px-3.5 py-1.5 text-sm font-medium text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
          >
            Observatory
          </Link>
          <Link
            href="/roles"
            className="rounded-full bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-fg shadow-sm transition-opacity hover:opacity-90"
          >
            Onboard an agent
          </Link>
        </div>
      </div>

      {onboarding > 0 ? (
        <p className="bh-hud pointer-events-auto w-fit shrink-0 rounded-full px-3.5 py-1.5 text-xs text-fg-muted">
          {onboarding} agent{onboarding === 1 ? '' : 's'} still onboarding —{' '}
          <Link href="/organization" className="font-medium text-primary hover:underline">
            finish setting them up
          </Link>
          .
        </p>
      ) : null}
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
      <Lobby
        people={lobby}
        parts={partLibrary}
        categories={AVATAR_PART_CATEGORIES}
        selectBasePath="/"
        departments={places.map((place) => ({
          id: place.id,
          name: place.name,
          slug: place.slug,
          sceneKind: (place.sceneKind ?? null) as SceneKind | null,
          backdropSvg: place.backdropSvg,
        }))}
        {...(departmentSlug ? { departmentSlug } : {})}
      >
        {widgets}
      </Lobby>
      {/* The record flyout opens over the floor — same drawer as the
          directory, no page change beneath it. */}
      {await personDrawer({ tenantId, roster: data.roster, selectedId, basePath: '/', searchParams: params })}
    </div>
  )
}
