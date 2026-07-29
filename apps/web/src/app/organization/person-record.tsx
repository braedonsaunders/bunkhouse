import type { ReactNode } from 'react'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import {
  DEEPGRAM_STT_MODELS,
  ELEVENLABS_TTS_MODELS,
  GEMINI_LIVE_MODELS,
  GEMINI_LIVE_VOICES,
  OPENAI_REALTIME_MODELS,
  OPENAI_REALTIME_VOICES,
} from '@appkit/voice'
import { isAiProvider, providerSpec } from '@appkit/ai'
import { approvals, autonomySettings, duties, memories, people, runs, tokenSpend } from '../../db/schema'
import { db } from '../../db/client'
import { listAiProviders } from '../../lib/ai'
import { getVoiceProviders, listRealtimeCapableProviders } from '../../lib/voice'
import { createEmptyComposition, getAvatarComposition, loadAvatarPartLibrary } from '../../lib/avatars'
import { AVATAR_PART_CATEGORIES } from '../../lib/avatar-parts'
import { scheduleToHuman } from '../../lib/schedule'
import { PersonDrawer, type PersonDrawerTab } from '../../components/person-drawer'
import { AvatarPortrait, AvatarStudio } from '../../components/avatar-studio'
import { VoiceConfigForm } from '../../components/voice-config-form'
import { DutiesCard } from '../../components/duties-card'
import { MailboxSection } from './mailbox-section'
import { AssignmentsSection } from './assignments-section'
import { AutonomySection, MemorySection, ModelSection, OverviewSection, PayrollSection } from './person-sections'

type Person = typeof people.$inferSelect

/**
 * The person record flyout, assembled once. Both organization surfaces — the
 * roster and the org chart — open the same drawer from `?person=<id>`, so the
 * record has a single definition and stays identical wherever it is opened.
 */
export async function personDrawer({
  tenantId,
  roster,
  selectedId,
  basePath,
  mailboxError,
  tab,
  mailThreadId,
}: {
  tenantId: string
  roster: Person[]
  selectedId?: string | undefined
  /** The organization surface the drawer was opened from; closing returns there. */
  basePath: string
  /** Set when a mailbox sign-in redirected back here without connecting. */
  mailboxError?: string | undefined
  /** Deep-link straight to a tab (e.g. ?tab=mailbox from old mail links). */
  tab?: string | undefined
  /** With tab=mailbox: the conversation to open. */
  mailThreadId?: string | undefined
}): Promise<ReactNode> {
  const selected = selectedId ? roster.find((person) => person.id === selectedId) : undefined
  if (!selected) return null

  const app = db()
  const isAgent = selected.kind === 'agent'
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
      .where(and(eq(memories.personId, selected.id), sql`${memories.validUntil} is null`))
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
    // Trust is earned: a category still on 'approval' whose last five decisions
    // were all approvals is ready for a promotion conversation.
    const decided = await app.db
      .select({ category: approvals.category, status: approvals.status, decidedAt: approvals.decidedAt })
      .from(approvals)
      .where(and(eq(approvals.personId, selected.id), sql`${approvals.status} in ('approved', 'rejected')`))
      .orderBy(desc(approvals.decidedAt))
      .limit(120)
    const byCategory = new Map<string, ('approved' | 'rejected')[]>()
    for (const row of decided) {
      const list = byCategory.get(row.category) ?? []
      if (list.length < 5) list.push(row.status as 'approved' | 'rejected')
      byCategory.set(row.category, list)
    }
    const dialByCategory = new Map(dial.map((s) => [s.category, s.level]))
    const graduationSuggestions = [...byCategory.entries()]
      .filter(
        ([category, decisions]) =>
          decisions.length === 5 &&
          decisions.every((d) => d === 'approved') &&
          (dialByCategory.get(category as (typeof dial)[number]['category']) ?? 'approval') === 'approval',
      )
      .map(([category]) => category)
    return {
      personDuties,
      dial,
      notes,
      monthSpend: Number(spend?.cost ?? 0),
      recentRuns,
      graduationSuggestions,
    }
  })

  // One figure per person, composed from the company parts library. The
  // header avatar is that figure cropped to its head viewport.
  const [composition, partLibrary] = await Promise.all([
    getAvatarComposition(tenantId, selected.id),
    loadAvatarPartLibrary(tenantId),
  ])

  const providers = isAgent ? await listAiProviders(tenantId) : []
  // Cascade calls run the agent's own model over the OpenAI protocol; resolve
  // whether this agent's assigned provider speaks it so the Voice tab only
  // offers combos that can actually hold a call.
  const assignedProvider = providers.find((p) => p.slug === selected.modelConfig?.provider)
  const assignedKind =
    assignedProvider && isAiProvider(assignedProvider.provider)
      ? providerSpec(assignedProvider.provider).kind
      : null
  const cascadeModelSupported =
    !selected.modelConfig || assignedKind === 'openai' || assignedKind === 'openai-compatible'
  const voiceProviders: Awaited<ReturnType<typeof getVoiceProviders>> = isAgent
    ? await getVoiceProviders(tenantId)
    : {}
  const realtimeProviders = isAgent ? await listRealtimeCapableProviders(tenantId) : []
  // Only somebody still here can be named as a manager — except the manager
  // already on the record, which stays selectable so the form round-trips.
  const rosterOptions = roster
    .filter((p) => p.status === 'active' || p.id === selected.reportsToId)
    .map((p) => ({ id: p.id, name: p.name, title: p.title }))

  const figure = composition ?? createEmptyComposition()

  const tabs: PersonDrawerTab[] = [
    {
      key: 'overview',
      label: 'Overview',
      content: (
        <OverviewSection person={selected} roster={rosterOptions} />
      ),
    },
    {
      key: 'avatar',
      label: 'Avatar',
      // The composer is a workbench: it manages its own scrolling and wants
      // the drawer's full height, like an app panel.
      fill: true,
      content: (
        <AvatarStudio
          personId={selected.id}
          name={selected.name}
          composition={figure}
          parts={partLibrary}
          categories={AVATAR_PART_CATEGORIES}
        />
      ),
    },
    ...(isAgent
      ? [
          {
            key: 'model',
            label: 'Model',
            content: (
              <ModelSection
                person={selected}
                providers={providers.map((p) => ({ slug: p.slug, label: p.label }))}
              />
            ),
          },
          {
            key: 'mailbox',
            label: 'Mailbox',
            // The inbox is a workbench: full drawer height, panes own their scroll.
            fill: true,
            content: (
              <MailboxSection
                tenantId={tenantId}
                personId={selected.id}
                basePath={basePath}
                selectedThreadId={mailThreadId}
                error={mailboxError}
              />
            ),
          },
          {
            key: 'duties',
            label: 'Duties',
            content: (
              <DutiesCard
                personId={selected.id}
                duties={detail.personDuties.map((duty) => {
                  // `interval` predates the flexible-schedule work and is not
                  // written by any authoring path; treat it as cron for display.
                  const kind = duty.scheduleKind === 'once' ? ('once' as const) : ('cron' as const)
                  return {
                    id: duty.id,
                    title: duty.title,
                    instruction: duty.instruction,
                    scheduleKind: kind,
                    schedule: duty.schedule,
                    scheduleHuman: scheduleToHuman({ kind, schedule: duty.schedule }, duty.timezone),
                    endsAt: duty.endsAt ? duty.endsAt.toISOString() : null,
                    maxRuns: duty.maxRuns,
                    enabled: duty.enabled,
                    lastRunAt: duty.lastRunAt ? duty.lastRunAt.toISOString().slice(0, 16).replace('T', ' ') : '',
                  }
                })}
              />
            ),
          },
          {
            key: 'work',
            label: 'Work',
            content: <AssignmentsSection tenantId={tenantId} personId={selected.id} />,
          },
          {
            key: 'voice',
            label: 'Voice',
            content: (
              <VoiceConfigForm
                personId={selected.id}
                name={selected.name}
                status={selected.status}
                current={selected.voiceConfig ?? null}
                realtimeProviders={realtimeProviders}
                speechConfigured={{
                  deepgram: Boolean(voiceProviders.deepgram),
                  elevenlabs: Boolean(voiceProviders.elevenlabs),
                }}
                cascadeModelSupported={cascadeModelSupported}
                extension={selected.extension ?? ''}
                catalogs={{
                  deepgramSttModels: DEEPGRAM_STT_MODELS,
                  elevenLabsTtsModels: ELEVENLABS_TTS_MODELS,
                  openaiRealtimeModels: OPENAI_REALTIME_MODELS,
                  openaiRealtimeVoices: OPENAI_REALTIME_VOICES,
                  geminiLiveModels: GEMINI_LIVE_MODELS,
                  geminiLiveVoices: GEMINI_LIVE_VOICES,
                }}
              />
            ),
          },
          {
            key: 'autonomy',
            label: 'Autonomy',
            content: (
              <AutonomySection person={selected} dial={detail.dial} suggestions={detail.graduationSuggestions} />
            ),
          },
          {
            key: 'memory',
            label: 'Memory',
            content: <MemorySection person={selected} notes={detail.notes} />,
          },
          {
            key: 'payroll',
            label: 'Cost',
            content: (
              <PayrollSection person={selected} monthSpend={detail.monthSpend} recentRuns={detail.recentRuns} />
            ),
          },
        ]
      : []),
  ]

  const manager = selected.reportsToId
    ? roster.find((person) => person.id === selected.reportsToId)
    : undefined

  return (
    <PersonDrawer
      key={selected.id}
      open
      basePath={basePath}
      name={selected.name}
      subtitle={`${selected.title}${manager ? ` · reports to ${manager.name}` : ''} · ${selected.email}`}
      kind={selected.kind}
      status={selected.status}
      initialTabKey={mailboxError ? 'mailbox' : tab}
      avatar={
        // Everyone in the organization gets a likeness — humans included.
        <AvatarPortrait
          name={selected.name}
          composition={figure}
          parts={partLibrary}
          categories={AVATAR_PART_CATEGORIES}
        />
      }
      avatarTabKey="avatar"
      tabs={tabs}
    />
  )
}
