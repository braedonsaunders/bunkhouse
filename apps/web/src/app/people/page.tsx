import Link from 'next/link'
import type { ReactNode } from 'react'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { Avatar, Button, PageContainer, PageHeader } from '@appkit/ui'
import { autonomySettings, avatarImages, duties, memories, people, runs, tokenSpend } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId } from '../../lib/tenant'
import { listAiProviders } from '../../lib/ai'
import { getImageProviderSetting } from '../../lib/avatars'
import { cronToHuman } from '../../lib/schedule'
import { PeopleList, type PersonRow } from '../../components/people-list'
import { PersonDrawer, type PersonDrawerTab } from '../../components/person-drawer'
import { AvatarStudio } from '../../components/avatar-studio'
import { DutiesCard } from '../../components/duties-card'
import { MailboxSection } from './mailbox-section'
import { AutonomySection, MemorySection, OverviewSection, PayrollSection } from './person-sections'

export const dynamic = 'force-dynamic'

const STATUS_LABELS = { onboarding: 'Onboarding', active: 'Active', offboarded: 'Offboarded' } as const

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ person?: string }>
}) {
  const { person: selectedId } = await searchParams
  const tenantId = await resolveTenantId()
  const app = db()
  const roster = await app.withTenantContext(tenantId, () =>
    app.db.select().from(people).orderBy(asc(people.name)),
  )
  const byId = new Map(roster.map((p) => [p.id, p]))
  const rows: PersonRow[] = roster.map((person) => ({
    id: person.id,
    name: person.name,
    title: person.title,
    kind: person.kind === 'hand' ? 'Hand' : 'Human',
    email: person.email,
    reportsTo: person.reportsToId ? (byId.get(person.reportsToId)?.name ?? '—') : '—',
    status: STATUS_LABELS[person.status],
  }))

  const selected = selectedId ? byId.get(selectedId) : undefined
  let tabs: PersonDrawerTab[] = []
  let avatarNode: ReactNode = null
  if (selected) {
    const isHand = selected.kind === 'hand'
    const detail = await app.withTenantContext(tenantId, async () => {
      const personDuties = await app.db
        .select()
        .from(duties)
        .where(eq(duties.personId, selected.id))
        .orderBy(asc(duties.title))
      const dial = await app.db.select().from(autonomySettings).where(eq(autonomySettings.personId, selected.id))
      const notes = await app.db
        .select()
        .from(memories)
        .where(eq(memories.personId, selected.id))
        .orderBy(asc(memories.createdAt))
      const monthStart = new Date()
      monthStart.setUTCDate(1)
      monthStart.setUTCHours(0, 0, 0, 0)
      const [spend] = await app.db
        .select({ cost: sql<string>`coalesce(sum(${tokenSpend.costUsd}), 0)` })
        .from(tokenSpend)
        .where(and(eq(tokenSpend.personId, selected.id), sql`${tokenSpend.createdAt} >= ${monthStart}`))
      const recentRuns = await app.db
        .select({ id: runs.id, status: runs.status, summary: runs.summary, startedAt: runs.startedAt })
        .from(runs)
        .where(eq(runs.personId, selected.id))
        .orderBy(desc(runs.startedAt))
        .limit(6)
      const [avatar] = await app.db
        .select({ id: avatarImages.id })
        .from(avatarImages)
        .where(eq(avatarImages.personId, selected.id))
      return { personDuties, dial, notes, monthSpend: Number(spend?.cost ?? 0), recentRuns, hasAvatar: !!avatar }
    })
    const providers = isHand ? await listAiProviders(tenantId) : []
    const imageSetting = isHand ? await getImageProviderSetting(tenantId) : null
    const rosterOptions = roster
      .filter((p) => p.status === 'active' || p.id === selected.reportsToId)
      .map((p) => ({ id: p.id, name: p.name, title: p.title }))

    avatarNode = isHand ? (
      <AvatarStudio
        personId={selected.id}
        name={selected.name}
        hasAvatar={detail.hasAvatar}
        model={imageSetting?.model ?? 'unconfigured'}
      />
    ) : (
      <Avatar name={selected.name} size={40} />
    )

    tabs = [
      {
        key: 'overview',
        label: 'Overview',
        content: (
          <OverviewSection
            person={selected}
            providers={providers.map((p) => ({ slug: p.slug, label: p.label }))}
            roster={rosterOptions}
          />
        ),
      },
      ...(isHand
        ? [
            {
              key: 'mailbox',
              label: 'Mailbox',
              content: <MailboxSection tenantId={tenantId} personId={selected.id} />,
            },
            {
              key: 'duties',
              label: 'Duties',
              content: (
                <DutiesCard
                  personId={selected.id}
                  duties={detail.personDuties.map((duty) => ({
                    id: duty.id,
                    title: duty.title,
                    instruction: duty.instruction,
                    schedule: duty.schedule,
                    scheduleHuman: cronToHuman(duty.schedule),
                    enabled: duty.enabled,
                    lastRunAt: duty.lastRunAt ? duty.lastRunAt.toISOString().slice(0, 16).replace('T', ' ') : '',
                  }))}
                />
              ),
            },
            {
              key: 'autonomy',
              label: 'Autonomy',
              content: <AutonomySection person={selected} dial={detail.dial} />,
            },
            {
              key: 'memory',
              label: 'Memory',
              content: <MemorySection person={selected} notes={detail.notes} />,
            },
            {
              key: 'payroll',
              label: 'Payroll & work',
              content: (
                <PayrollSection person={selected} monthSpend={detail.monthSpend} recentRuns={detail.recentRuns} />
              ),
            },
          ]
        : []),
    ]
  }

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Directory"
        description="Everyone who works here — your people and your hands, one org."
        actions={
          <Button asChild>
            <Link href="/people/hire">Hire a hand</Link>
          </Button>
        }
      />
      <PeopleList rows={rows} />
      {selected ? (
        <PersonDrawer
          key={selected.id}
          open
          name={selected.name}
          subtitle={`${selected.title}${selected.reportsToId ? ` · reports to ${byId.get(selected.reportsToId)?.name ?? ''}` : ''} · ${selected.email}`}
          kind={selected.kind}
          status={selected.status}
          avatar={avatarNode}
          tabs={tabs}
        />
      ) : null}
    </PageContainer>
  )
}
