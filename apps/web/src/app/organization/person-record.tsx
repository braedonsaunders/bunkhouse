import type { ReactNode } from 'react'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import {
  DEEPGRAM_STT_MODELS,
  ELEVENLABS_TTS_MODELS,
  GEMINI_LIVE_MODELS,
  GEMINI_LIVE_VOICES,
  OPENAI_REALTIME_MODELS,
  OPENAI_REALTIME_VOICES,
} from '@braedonsaunders/appkit-voice'
import { Pagination, parsePrefixedListParams, type ListSearchParams } from '@braedonsaunders/appkit-ui'
import { isAiProvider, providerSpec } from '@braedonsaunders/appkit-ai'
import { approvals, autonomySettings, departments, duties, memories, people, runs, tokenSpend } from '../../db/schema'
import { db } from '../../db/client'
import { listAiProviders, resolveAgentAiConfig } from '../../lib/ai'
import { getVoiceProviders, listRealtimeCapableProviders } from '../../lib/voice'
import { createEmptyComposition, getAvatarComposition, loadAvatarPartLibrary } from '../../lib/avatars'
import { AVATAR_PART_CATEGORIES } from '../../lib/avatar-parts'
import { scheduleToHuman } from '../../lib/schedule'
import { personAccountAccess } from '../../lib/person-accounts'
import { resolveCallAction } from '../../lib/call-action'
import { PersonDrawer, type PersonDrawerTab } from '../../components/person-drawer'
import { CallActionButton } from '../../components/call-action-button'
import { AvatarPortrait, AvatarStudio } from '../../components/avatar-studio'
import { VoiceConfigForm } from '../../components/voice-config-form'
import { DutiesCard } from '../../components/duties-card'
import { MailboxSection } from './mailbox-section'
import { AssignmentsSection } from './assignments-section'
import {
  AccountSection,
  AgentActivitySection,
  AgentOverviewSection,
  AgentRoleSection,
  AutonomySection,
  MemorySection,
  ModelSection,
  OverviewSection,
  PayrollSection,
} from './person-sections'
import { AgentChatWorkspace, type ChatThreadDetail } from '../../components/chat-workspace'
import { AgentRecordPage, AgentRecordSubsections, type AgentPageSection } from '../../components/agent-record-page'
import { getThread, listThreads } from '../../lib/chat-threads'
import { listResourceCatalog } from '../../lib/role-resources'
import { agentBinding, bindsToAgent } from '../../lib/assignment'
import { listRoles } from '../../lib/roles'

type Person = typeof people.$inferSelect

/** Assemble the canonical agent page and the compact human record drawer. */
export async function personDrawer({
  tenantId,
  roster,
  selectedId,
  basePath,
  mailboxError,
  tab,
  mailThreadId,
  searchParams,
  display = 'drawer',
  pageAccess,
  section,
  chatThreadId,
  profileSection,
  workSection,
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
  /**
   * The page's own query string, so the memory table can be paged without
   * losing whichever person and tab are open.
   */
  searchParams?: ListSearchParams | undefined
  /** Agents use a full record page; humans and compact organization surfaces use the drawer. */
  display?: 'drawer' | 'page'
  pageAccess?: {
    userId: string
    canReadWork: boolean
    canReadMail: boolean
    canCall: boolean
  }
  section?: string
  chatThreadId?: string
  profileSection?: string
  workSection?: string
}): Promise<ReactNode> {
  const selected = selectedId ? roster.find((person) => person.id === selectedId) : undefined
  if (!selected) return null

  const app = db()
  const isAgent = selected.kind === 'agent'
  // Its own prefix: the drawer shares a route with the roster, and one list's
  // controls must not reset another's.
  const notePage = parsePrefixedListParams(searchParams ?? {}, 'note', {
    sort: 'created',
    dir: 'desc',
    perPage: 20,
    allowedSorts: ['created'] as const,
  })
  const detail = await app.withTenantContext(tenantId, async () => {
    const personDuties = await app.db
      .select()
      .from(duties)
      .where(eq(duties.personId, selected.id))
      .orderBy(asc(duties.title))
    const dial = await app.db.select().from(autonomySettings).where(eq(autonomySettings.personId, selected.id))
    // Paged, because a logbook only grows. One agent wrote 195 notes in a day
    // and this loaded every one of them into the page, oldest first — so the
    // newest, which is the only part anybody opens this to read, was last.
    const noteWhere = and(eq(memories.personId, selected.id), sql`${memories.validUntil} is null`)
    const [noteCount] = await app.db
      .select({ total: sql<number>`count(*)`.mapWith(Number) })
      .from(memories)
      .where(noteWhere)
    const notesTotal = noteCount?.total ?? 0
    const notes = await app.db
      .select()
      .from(memories)
      .where(noteWhere)
      .orderBy(desc(memories.pinned), desc(memories.createdAt))
      .limit(notePage.perPage)
      .offset((notePage.page - 1) * notePage.perPage)
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
    const [pendingApprovalCount] = await app.db
      .select({ total: sql<number>`count(*)`.mapWith(Number) })
      .from(approvals)
      .where(and(eq(approvals.personId, selected.id), eq(approvals.status, 'pending')))
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
      notesTotal,
      // The company's places, for the desk picker on the record.
      departments: await app.db
        .select({ id: departments.id, name: departments.name })
        .from(departments)
        .orderBy(asc(departments.position), asc(departments.name)),
      personDuties,
      dial,
      notes,
      monthSpend: Number(spend?.cost ?? 0),
      recentRuns,
      pendingApprovals: pendingApprovalCount?.total ?? 0,
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
  const accountAccess = isAgent ? null : await personAccountAccess(tenantId, selected.id)
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
        <OverviewSection person={selected} roster={rosterOptions} departments={detail.departments} />
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
    ...(!isAgent && accountAccess
      ? [
          {
            key: 'access',
            label: 'Access',
            content: <AccountSection person={selected} access={accountAccess} />,
          },
        ]
      : []),
    ...(isAgent
      ? [
          {
            key: 'model',
            label: 'Model',
            content: (
              <ModelSection
                person={selected}
                providers={providers.map((p) => ({
                  slug: p.slug,
                  label: p.label,
                  // The provider's own quick model: what an agent that names
                  // none of its own answers with on a call.
                  ...(p.modelFast ? { modelFast: p.modelFast } : {}),
                }))}
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
            content: (
              <MemorySection
                person={selected}
                notes={detail.notes}
                pagination={
                  <Pagination
                    basePath={basePath}
                    currentParams={searchParams ?? {}}
                    total={detail.notesTotal}
                    page={notePage.page}
                    perPage={notePage.perPage}
                    pageParamKey="notePage"
                  />
                }
              />
            ),
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

  // Reaching an agent is a property of the record, not of one of its tabs, so
  // the action sits in the drawer header wherever the record is opened from.
  const callAction = resolveCallAction(selected)

  if (display === 'page' && isAgent) {
    const activeRun = detail.recentRuns.find((run) =>
      ['running', 'waiting_approval', 'waiting_reply'].includes(run.status),
    ) ?? null
    const nextDutyRow = [...detail.personDuties]
      .filter((duty) => duty.enabled === 'on')
      .sort((a, b) => {
        if (!a.nextDueAt) return 1
        if (!b.nextDueAt) return -1
        return a.nextDueAt.getTime() - b.nextDueAt.getTime()
      })[0]
    const nextDuty = nextDutyRow
      ? {
          title: nextDutyRow.title,
          schedule: scheduleToHuman({
            kind: nextDutyRow.scheduleKind === 'once' ? 'once' : 'cron',
            schedule: nextDutyRow.schedule,
          }, nextDutyRow.timezone),
          dueAt: nextDutyRow.nextDueAt ? nextDutyRow.nextDueAt.toLocaleString() : null,
        }
      : null

    const [resourceCatalog, roles] = await Promise.all([
      listResourceCatalog(tenantId),
      listRoles(tenantId),
    ])
    const binding = agentBinding(selected)
    const resourceCounts = {
      procedures: resourceCatalog.procedures.filter((entry) => bindsToAgent(entry.assignment, binding)).length,
      skills: resourceCatalog.skills.filter((entry) => bindsToAgent(entry.assignment, binding)).length,
      notes: resourceCatalog.notes.filter((entry) => bindsToAgent(entry.assignment, binding)).length,
      systems: resourceCatalog.systems.filter((entry) => bindsToAgent(entry.assignment, binding)).length,
    }

    const canReadWork = pageAccess?.canReadWork === true
    const openThreads = canReadWork && pageAccess
      ? await listThreads({ tenantId, userId: pageAccess.userId, personId: selected.id })
      : []
    const reachableThreads = chatThreadId && canReadWork && pageAccess
      ? await listThreads({
          tenantId,
          userId: pageAccess.userId,
          personId: selected.id,
          includeArchived: true,
        })
      : openThreads
    const visibleThreads = chatThreadId && reachableThreads.some((thread) => thread.id === chatThreadId)
      ? reachableThreads
      : openThreads
    const selectedChatThreadId = chatThreadId && reachableThreads.some((thread) => thread.id === chatThreadId)
      ? chatThreadId
      : openThreads[0]?.id
    const initialChat: ChatThreadDetail | null = selectedChatThreadId
      ? await getThread(tenantId, selectedChatThreadId)
      : null
    const canStartChat = canReadWork && Boolean(await resolveAgentAiConfig(tenantId, selected.id))

    const profileSections: AgentPageSection[] = [
      {
        key: 'identity',
        label: 'Identity',
        content: <OverviewSection person={selected} roster={rosterOptions} departments={detail.departments} />,
      },
      {
        key: 'role',
        label: 'Role & resources',
        content: (
          <AgentRoleSection
            roleLabel={roles.find((role) => role.slug === selected.roleSlug)?.title ?? selected.roleSlug}
            resourceCounts={resourceCounts}
          />
        ),
      },
      {
        key: 'avatar',
        label: 'Avatar',
        content: (
          <div className="min-h-[36rem] overflow-hidden rounded-lg border border-border bg-surface md:h-[calc(100dvh-17rem)] md:max-h-[48rem]">
            <AvatarStudio
              personId={selected.id}
              name={selected.name}
              composition={figure}
              parts={partLibrary}
              categories={AVATAR_PART_CATEGORIES}
            />
          </div>
        ),
      },
      {
        key: 'model',
        label: 'Model',
        content: (
          <ModelSection
            person={selected}
            providers={providers.map((provider) => ({
              slug: provider.slug,
              label: provider.label,
              ...(provider.modelFast ? { modelFast: provider.modelFast } : {}),
            }))}
          />
        ),
      },
      {
        key: 'voice',
        label: 'Voice',
        content: (
          <VoiceConfigForm
            personId={selected.id}
            name={selected.name}
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
        content: <AutonomySection person={selected} dial={detail.dial} suggestions={detail.graduationSuggestions} />,
      },
      {
        key: 'memory',
        label: 'Memory',
        content: (
          <MemorySection
            person={selected}
            notes={detail.notes}
            pagination={
              <Pagination
                basePath={`/organization/${selected.id}`}
                currentParams={searchParams ?? {}}
                total={detail.notesTotal}
                page={notePage.page}
                perPage={notePage.perPage}
                pageParamKey="notePage"
              />
            }
          />
        ),
      },
      {
        key: 'compensation',
        label: 'Compensation',
        content: <PayrollSection person={selected} monthSpend={detail.monthSpend} recentRuns={detail.recentRuns} />,
      },
    ]

    const workSections: AgentPageSection[] = [
      {
        key: 'duties',
        label: 'Duties',
        content: (
          <DutiesCard
            personId={selected.id}
            duties={detail.personDuties.map((duty) => {
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
        key: 'assignments',
        label: 'Assignments',
        content: <AssignmentsSection tenantId={tenantId} personId={selected.id} />,
      },
      {
        key: 'activity',
        label: 'Activity',
        content: <AgentActivitySection recentRuns={detail.recentRuns} />,
      },
    ]

    const pageSections: AgentPageSection[] = [
      {
        key: 'overview',
        label: 'Overview',
        content: (
          <AgentOverviewSection
            person={selected}
            monthSpend={detail.monthSpend}
            pendingApprovals={detail.pendingApprovals}
            activeRun={activeRun}
            nextDuty={nextDuty}
            recentRuns={detail.recentRuns}
          />
        ),
      },
      ...(pageAccess?.canReadMail
        ? [{
            key: 'inbox',
            label: 'Inbox',
            content: (
              <div className="h-full min-h-[36rem] lg:min-h-0">
                <MailboxSection
                  tenantId={tenantId}
                  personId={selected.id}
                  selectedThreadId={mailThreadId}
                  error={mailboxError}
                />
              </div>
            ),
          } satisfies AgentPageSection]
        : []),
      ...(canReadWork
        ? [{
            key: 'chat',
            label: 'Chat',
            content: (
              <AgentChatWorkspace
                threads={visibleThreads}
                agent={{ id: selected.id, name: selected.name, title: selected.title }}
                avatar={
                  <AvatarPortrait
                    name={selected.name}
                    composition={figure}
                    parts={partLibrary}
                    categories={AVATAR_PART_CATEGORIES}
                    size={26}
                  />
                }
                callAvatar={{ composition, parts: partLibrary, categories: AVATAR_PART_CATEGORIES }}
                canStart={canStartChat}
                initialThread={initialChat}
              />
            ),
          } satisfies AgentPageSection,
          {
            key: 'work',
            label: 'Work',
            content: (
              <AgentRecordSubsections
                sections={workSections}
                initialSection={workSection}
                ariaLabel={`${selected.name}'s work`}
              />
            ),
          } satisfies AgentPageSection]
        : []),
      {
        key: 'profile',
        label: 'Profile',
        content: (
          <AgentRecordSubsections
            sections={profileSections}
            initialSection={profileSection}
            ariaLabel={`${selected.name}'s profile`}
          />
        ),
      },
    ]

    return (
      <AgentRecordPage
        agentId={selected.id}
        name={selected.name}
        subtitle={`${selected.title}${manager ? ` · reports to ${manager.name}` : ''} · ${selected.email}`}
        status={selected.status}
        avatar={
          <AvatarPortrait
            name={selected.name}
            composition={figure}
            parts={partLibrary}
            categories={AVATAR_PART_CATEGORIES}
            size={44}
          />
        }
        contactAction={pageAccess?.canCall && callAction ? <CallActionButton action={callAction} name={selected.name} /> : undefined}
        sections={pageSections}
        initialSection={mailboxError ? 'inbox' : section}
      />
    )
  }

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
      contactAction={callAction ? <CallActionButton action={callAction} name={selected.name} /> : undefined}
      tabs={tabs}
    />
  )
}
