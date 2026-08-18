import type { ReactNode } from 'react'
import { asc, eq, inArray, sql } from 'drizzle-orm'
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@braedonsaunders/appkit-ui'
import { formatAttachmentSize } from '@braedonsaunders/appkit-storage'
import {
  approvals,
  callSessions,
  callTurns,
  // Aliased: this module already names its activity-feed rows `deskEvents`.
  deskEvents as deskEventsTable,
  deskSessions,
  files,
  people,
  procedureRevisions,
  procedures,
  runEvents,
  runAttempts,
  runAttemptEvents,
  externalEffectIntents,
  externalEffectEvents,
  runs,
  tokenSpend,
} from '../../db/schema'
import { db } from '../../db/client'
import {
  deskEventPresentation,
  toolActivityFromEvents,
  type CallActivityEvent,
} from '../../lib/call-activity'
import {
  RunActivity,
  RunTranscript,
  type ApprovalArtifact,
  type DeskEvent,
  type ProcedureArtifact,
} from '../../components/run-activity'
import {
  RunApprovalsTable,
  RunDeskEventsTable,
  RunFilesTable,
  RunProceduresTable,
  RunSpendTable,
  RunAttemptsTable,
  RunEffectsTable,
  type RunApprovalRow,
  type RunDeskEventRow,
  type RunFileRow,
  type RunProcedureRow,
  type RunSpendRow,
  type RunAttemptRow,
  type RunEffectRow,
} from '../../components/run-tables'
import { RunDrawer, type RunRecordTab } from '../../components/run-drawer'
import { LiveToggle } from '../../components/live-toggle'
import { StopRunButton } from '../../components/stop-run-button'

/**
 * The run record, assembled once. The observatory opens it as a flyout from
 * `?run=<id>`; `/runs/[id]` renders the same sections as a page for deep
 * links — so the record has a single definition wherever it is read.
 */

const STATUS_BADGES: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  completed: 'default',
  running: 'secondary',
  waiting_approval: 'outline',
  waiting_reply: 'outline',
  failed: 'destructive',
  cancelled: 'outline',
}

const OPEN_STATUSES = new Set(['running', 'waiting_approval', 'waiting_reply'])

export function describeTrigger(trigger: Record<string, unknown>): string {
  switch (trigger.type) {
    case 'email':
      return 'Inbound email'
    case 'duty':
      return 'Scheduled duty'
    case 'chat':
      return 'Chat'
    case 'delegation':
      return 'Delegated task'
    case 'assignment':
      return 'Assignment'
    case 'approval_followup':
      return 'Approval follow-up'
    default:
      return 'Manual'
  }
}

const stamp = (value: Date | null): string => (value ? value.toISOString().slice(0, 16).replace('T', ' ') : '—')

function formatDuration(startedAt: Date, finishedAt: Date | null): string {
  if (!finishedAt) return 'still running'
  const seconds = Math.max(0, Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** One labelled fact in the overview's summary card. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="text-sm text-fg">{children}</dd>
    </div>
  )
}

export type RunRecordView = {
  runId: string
  title: string
  subtitle: string
  status: string
  isOpen: boolean
  agent: { id: string; name: string; title: string } | null
  tabs: RunRecordTab[]
}

/** Loads a run and composes its subtabs; null when the run does not exist. */
export async function loadRunRecord({
  tenantId,
  runId,
}: {
  tenantId: string
  runId: string
}): Promise<RunRecordView | null> {
  const app = db()

  const data = await app.withTenantContext(tenantId, async () => {
    const [run] = await app.db.select().from(runs).where(eq(runs.id, runId))
    if (!run) return null
    const [agent] = await app.db
      .select({ id: people.id, name: people.name, title: people.title })
      .from(people)
      .where(eq(people.id, run.personId))
    const events = await app.db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.seq))
    const attempts = await app.db.select().from(runAttempts).where(eq(runAttempts.runId, runId)).orderBy(asc(runAttempts.fence))
    const attemptEvents = attempts.length
      ? await app.db.select().from(runAttemptEvents).where(inArray(runAttemptEvents.attemptId, attempts.map((attempt) => attempt.id))).orderBy(asc(runAttemptEvents.seq))
      : []
    const effects = await app.db.select().from(externalEffectIntents).where(eq(externalEffectIntents.runId, runId)).orderBy(asc(externalEffectIntents.createdAt))
    const effectEvents = effects.length
      ? await app.db.select().from(externalEffectEvents).where(inArray(externalEffectEvents.effectId, effects.map((effect) => effect.id))).orderBy(asc(externalEffectEvents.seq))
      : []
    const [spend] = await app.db
      .select({
        cost: sql<string>`coalesce(sum(${tokenSpend.costUsd}), 0)`,
        inputTokens: sql<number>`coalesce(sum(${tokenSpend.inputTokens}), 0)`.mapWith(Number),
        outputTokens: sql<number>`coalesce(sum(${tokenSpend.outputTokens}), 0)`.mapWith(Number),
        sources: sql<string[]>`array_agg(distinct ${tokenSpend.priceSource})`,
        models: sql<string[]>`array_agg(distinct ${tokenSpend.model})`,
      })
      .from(tokenSpend)
      .where(eq(tokenSpend.runId, runId))
    // The spend subtab meters every model call individually — the aggregate
    // above is only the headline.
    const spendRows = await app.db
      .select()
      .from(tokenSpend)
      .where(eq(tokenSpend.runId, runId))
      .orderBy(asc(tokenSpend.createdAt))

    // Cited procedure revisions are pinned by slug+version, so the record
    // always shows the text the agent actually followed.
    const citedSlugs = [
      ...new Set(
        events
          .filter((e) => e.kind === 'procedure_citation')
          .map((e) => String(e.payload.slug))
          .filter(Boolean),
      ),
    ]
    const citedProcedures = citedSlugs.length
      ? await app.db
          .select({ id: procedures.id, slug: procedures.slug, title: procedures.title, status: procedures.status })
          .from(procedures)
          .where(inArray(procedures.slug, citedSlugs))
      : []
    const revisions = citedProcedures.length
      ? await app.db
          .select({
            procedureId: procedureRevisions.procedureId,
            version: procedureRevisions.version,
            body: procedureRevisions.body,
          })
          .from(procedureRevisions)
          .where(
            inArray(
              procedureRevisions.procedureId,
              citedProcedures.map((p) => p.id),
            ),
          )
      : []
    const approvalRows = await app.db
      .select({
        id: approvals.id,
        category: approvals.category,
        payload: approvals.payload,
        status: approvals.status,
        decidedAt: approvals.decidedAt,
        decisionNote: approvals.decisionNote,
        expiresAt: approvals.expiresAt,
        decidedByName: people.name,
        executedAt: approvals.executedAt,
        executionStatus: approvals.executionStatus,
        executionError: approvals.executionError,
      })
      .from(approvals)
      .leftJoin(people, eq(people.id, approvals.decidedById))
      .where(eq(approvals.runId, runId))
    // A call run carries its transcript ledger as its own subtab.
    const [callSession] = await app.db
      .select({ id: callSessions.id, startedAt: callSessions.startedAt })
      .from(callSessions)
      .where(eq(callSessions.runId, runId))
    const transcript = callSession
      ? await app.db
          .select({ speaker: callTurns.speaker, text: callTurns.text, atMs: callTurns.atMs })
          .from(callTurns)
          .where(eq(callTurns.sessionId, callSession.id))
          .orderBy(asc(callTurns.seq))
      : null
    const producedFiles = await app.db.select().from(files).where(eq(files.runId, runId)).orderBy(asc(files.createdAt))
    // Desk work is recorded, always: one session per run, one interleaved
    // event stream — terminal, browser, and screen in the order they happened
    // (docs/agent-desk.md §3.19), with the frames filed alongside.
    const [deskSession] = await app.db
      .select({
        id: deskSessions.id,
        status: deskSessions.status,
        screenReason: deskSessions.screenReason,
        screenOpenedAt: deskSessions.screenOpenedAt,
      })
      .from(deskSessions)
      .where(eq(deskSessions.runId, runId))
    const deskEventRows = deskSession
      ? await app.db
          .select({
            seq: deskEventsTable.seq,
            kind: deskEventsTable.kind,
            detail: deskEventsTable.detail,
            screenshotFileId: deskEventsTable.screenshotFileId,
          })
          .from(deskEventsTable)
          .where(eq(deskEventsTable.sessionId, deskSession.id))
          .orderBy(asc(deskEventsTable.seq))
      : []
    return {
      run,
      agent: agent ?? null,
      events,
      attempts,
      attemptEvents,
      effects,
      effectEvents,
      spend,
      spendRows,
      citedProcedures,
      revisions,
      approvalRows,
      callSession: callSession ?? null,
      transcript,
      producedFiles,
      deskSession: deskSession ?? null,
      deskEventRows,
    }
  })

  if (!data) return null
  const { run, agent, events, spend } = data
  const unpriced = (spend?.sources ?? []).includes('unpriced')
  const totalCost = Number(spend?.cost ?? 0)

  const procedureById = new Map(data.citedProcedures.map((p) => [p.id, p]))
  const procedureArtifacts: Record<string, ProcedureArtifact> = {}
  for (const rev of data.revisions) {
    const procedure = procedureById.get(rev.procedureId)
    if (!procedure) continue
    procedureArtifacts[`${procedure.slug}@v${rev.version}`] = {
      slug: procedure.slug,
      version: rev.version,
      title: procedure.title,
      status: procedure.status,
      body: rev.body,
    }
  }
  const approvalArtifacts: Record<string, ApprovalArtifact> = {}
  for (const row of data.approvalRows) {
    approvalArtifacts[row.id] = {
      id: row.id,
      category: row.category,
      description: row.payload.description,
      status: row.status,
      decidedBy: row.decidedByName ?? null,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      decisionNote: row.decisionNote,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    }
  }
  const deskEvents: DeskEvent[] = events.map((event) => ({
    id: event.id,
    seq: event.seq,
    kind: event.kind,
    at: event.createdAt.toISOString(),
    payload: event.payload,
  }))

  // Tool activity during a call, offset onto the call clock so the transcript
  // can interleave what the agent did with what was said.
  const callStartMs = data.callSession?.startedAt.getTime() ?? null
  const callActivity =
    callStartMs !== null
      ? toolActivityFromEvents(
          events
            .filter((e) => e.kind === 'tool_call' || e.kind === 'tool_result' || e.kind === 'approval_request')
            .map((e) => ({
              seq: e.seq,
              kind: e.kind as CallActivityEvent['kind'],
              atMs: Math.max(0, e.createdAt.getTime() - callStartMs),
              payload: e.payload,
            })),
        )
      : []

  const fileRows: RunFileRow[] = data.producedFiles.map((file) => ({
    id: file.id,
    filename: file.filename,
    kind: file.kind,
    size: formatAttachmentSize(file.sizeBytes),
    sizeBytes: file.sizeBytes,
    created: stamp(file.createdAt),
    createdAt: file.createdAt.toISOString(),
  }))

  const approvalTableRows: RunApprovalRow[] = data.approvalRows.map((row) => ({
    id: row.id,
    category: row.category,
    description: row.payload.description,
    status: row.status,
    decidedBy: row.decidedByName ?? '—',
    decided: stamp(row.decidedAt),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : '',
    expires: stamp(row.expiresAt),
    // Deciding is not doing. A decision that was never carried out — because
    // the agent had left, or because it was given up on after too many
    // attempts — reads identically to one that was, unless the run says so.
    carriedOut:
      row.status !== 'approved' && row.status !== 'rejected'
        ? '—'
        : !row.executedAt
          ? 'Carrying out'
          : row.executionStatus === 'succeeded'
            ? 'Carried out'
            : 'Not carried out',
    carriedOutDetail: row.executionError,
  }))

  const deskRows: RunDeskEventRow[] = data.deskEventRows.map((event) => ({
    seq: event.seq,
    kind: event.kind,
    ...deskEventPresentation(event.kind, event.detail),
    screenshotFileId: event.screenshotFileId,
  }))

  const attemptRows: RunAttemptRow[] = data.attempts.map((attempt) => {
    const history = data.attemptEvents.filter((event) => event.attemptId === attempt.id)
    const latest = history.at(-1)
    return {
      id: attempt.id,
      fence: attempt.fence,
      owner: attempt.owner,
      status: latest?.kind ?? 'claimed',
      startedAt: attempt.startedAt.toISOString(),
      lastAt: (latest?.at ?? attempt.startedAt).toISOString(),
    }
  })

  const effectRows: RunEffectRow[] = data.effects.map((effect) => {
    const history = data.effectEvents.filter((event) => event.effectId === effect.id)
    const latest = history.at(-1)
    return {
      id: effect.id,
      kind: effect.kind,
      idempotencyKey: effect.idempotencyKey,
      status: latest?.kind ?? 'intended',
      createdAt: effect.createdAt.toISOString(),
      lastAt: (latest?.at ?? effect.createdAt).toISOString(),
      request: effect.request,
      history: history.map((event) => ({
        seq: event.seq,
        kind: event.kind,
        at: event.at.toISOString(),
        payload: event.payload,
      })),
    }
  })

  const spendTableRows: RunSpendRow[] = data.spendRows.map((row) => ({
    id: row.id,
    at: stamp(row.createdAt),
    atIso: row.createdAt.toISOString(),
    provider: row.provider,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cost: `$${Number(row.costUsd).toFixed(4)}`,
    costUsd: Number(row.costUsd),
    priceSource: row.priceSource ?? 'unpriced',
  }))

  // One row per revision the run cited, stamped with when it was consulted.
  const firstCitation = new Map<string, Date>()
  for (const event of events) {
    if (event.kind !== 'procedure_citation') continue
    const key = `${String(event.payload.slug)}@v${String(event.payload.version)}`
    if (!firstCitation.has(key)) firstCitation.set(key, event.createdAt)
  }
  const procedureRows: RunProcedureRow[] = [...firstCitation.entries()].flatMap(([key, at]) => {
    const artifact = procedureArtifacts[key]
    if (!artifact) return []
    return [
      {
        key,
        slug: artifact.slug,
        title: artifact.title,
        version: artifact.version,
        status: artifact.status,
        citedAt: stamp(at),
        citedAtIso: at.toISOString(),
        body: artifact.body,
      },
    ]
  })

  const triggerLabel = describeTrigger(run.trigger)
  const models = (spend?.models ?? []).filter(Boolean)

  const tabs: RunRecordTab[] = [
    {
      key: 'overview',
      label: 'Overview',
      content: (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Cost</CardTitle>
                <CardDescription>
                  {models.join(', ') || 'no model calls'}
                  {unpriced ? ' · contains unpriced spend' : ''}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p className="text-2xl font-semibold tabular-nums">${totalCost.toFixed(4)}</p>
                <p className="tabular-nums text-fg-muted">
                  {spend?.inputTokens ?? 0} in · {spend?.outputTokens ?? 0} out tokens
                </p>
                {unpriced ? <Badge variant="destructive">unpriced — set a price in Settings</Badge> : null}
              </CardContent>
            </Card>
            <Card className="md:col-span-2">
              <CardHeader>
                <CardTitle>Outcome</CardTitle>
                <CardDescription>What this run set out to do, and how it ended.</CardDescription>
              </CardHeader>
              <CardContent className="whitespace-pre-wrap text-sm">{run.summary ?? 'Still working…'}</CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>At a glance</CardTitle>
              <CardDescription>Who worked, what set them off, and when.</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Fact label="Agent">{agent ? `${agent.name} · ${agent.title}` : '—'}</Fact>
                <Fact label="Trigger">{triggerLabel}</Fact>
                <Fact label="Status">
                  <Badge variant={STATUS_BADGES[run.status] ?? 'outline'}>{run.status.replace('_', ' ')}</Badge>
                </Fact>
                <Fact label="Duration">{formatDuration(run.startedAt, run.finishedAt)}</Fact>
                <Fact label="Started">
                  <span className="tabular-nums">{stamp(run.startedAt)}</span>
                </Fact>
                <Fact label="Finished">
                  <span className="tabular-nums">{stamp(run.finishedAt)}</span>
                </Fact>
                <Fact label="Ledger events">
                  <span className="tabular-nums">{events.length}</span>
                </Fact>
                <Fact label="Model calls">
                  <span className="tabular-nums">{spendTableRows.length}</span>
                </Fact>
              </dl>
            </CardContent>
          </Card>
        </div>
      ),
    },
    {
      key: 'activity',
      label: 'Activity',
      count: events.length,
      content: <RunActivity events={deskEvents} procedures={procedureArtifacts} approvals={approvalArtifacts} />,
    },
  ]

  if (data.transcript) {
    tabs.push({
      key: 'transcript',
      label: 'Transcript',
      count: data.transcript.length,
      content: (
        <Card>
          <CardHeader>
            <CardTitle>Call transcript</CardTitle>
            <CardDescription>
              Every turn of the call and everything the agent did during it, from the append-only ledger — corrections
              would be new records, never edits.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RunTranscript
              transcript={data.transcript}
              activity={callActivity}
              agentName={agent?.name ?? 'Agent'}
            />
          </CardContent>
        </Card>
      ),
    })
  }

  if (attemptRows.length > 0) {
    tabs.push({
      key: 'execution',
      label: 'Execution',
      count: attemptRows.length,
      content: (
        <Card>
          <CardHeader>
            <CardTitle>Execution attempts</CardTitle>
            <CardDescription>
              Every executor claim and terminal outcome, ordered by its monotonic fence. A superseded attempt cannot
              finalize this run.
            </CardDescription>
          </CardHeader>
          <CardContent><RunAttemptsTable rows={attemptRows} /></CardContent>
        </Card>
      ),
    })
  }

  if (effectRows.length > 0) {
    tabs.push({
      key: 'effects',
      label: 'External effects',
      count: effectRows.length,
      content: (
        <Card>
          <CardHeader>
            <CardTitle>External effects</CardTitle>
            <CardDescription>
              Immutable intent, idempotency identity, and append-only outcome evidence for actions outside Bunkhouse.
              An uncertain outcome is never repeated automatically.
            </CardDescription>
          </CardHeader>
          <CardContent><RunEffectsTable rows={effectRows} /></CardContent>
        </Card>
      ),
    })
  }

  if (data.deskSession) {
    tabs.push({
      key: 'desk',
      label: 'Desk',
      count: deskRows.length,
      content: (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Desk session
              <Badge variant={data.deskSession.status === 'failed' ? 'destructive' : 'outline'}>
                {data.deskSession.status}
              </Badge>
              {data.deskSession.screenOpenedAt ? <Badge variant="default">screen opened</Badge> : null}
            </CardTitle>
            <CardDescription>
              Everything this run did at its desk — terminal, browser, and screen as one continuous record, with the
              screen as it looked — work at the desk is always replayable.
              {data.deskSession.screenReason
                ? ` The screen was opened for a recorded reason: “${data.deskSession.screenReason}”.`
                : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RunDeskEventsTable rows={deskRows} />
          </CardContent>
        </Card>
      ),
    })
  }

  if (fileRows.length > 0) {
    tabs.push({
      key: 'files',
      label: 'Work product',
      count: fileRows.length,
      content: (
        <Card>
          <CardHeader>
            <CardTitle>Work product</CardTitle>
            <CardDescription>
              Files this run produced or received — the real deliverables, kept on the record.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RunFilesTable rows={fileRows} />
          </CardContent>
        </Card>
      ),
    })
  }

  if (approvalTableRows.length > 0) {
    tabs.push({
      key: 'approvals',
      label: 'Approvals',
      count: approvalTableRows.length,
      content: (
        <Card>
          <CardHeader>
            <CardTitle>Approvals</CardTitle>
            <CardDescription>
              Actions this run needed a human decision on, and how each was decided.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RunApprovalsTable rows={approvalTableRows} />
          </CardContent>
        </Card>
      ),
    })
  }

  if (procedureRows.length > 0) {
    tabs.push({
      key: 'procedures',
      label: 'Procedures',
      count: procedureRows.length,
      content: (
        <Card>
          <CardHeader>
            <CardTitle>Procedures followed</CardTitle>
            <CardDescription>
              The exact revisions this run cited, pinned by version — later edits never rewrite this record.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RunProceduresTable rows={procedureRows} />
          </CardContent>
        </Card>
      ),
    })
  }

  tabs.push({
    key: 'spend',
    label: 'Spend',
    count: spendTableRows.length,
    content: (
      <Card>
        <CardHeader>
          <CardTitle>Model spend</CardTitle>
          <CardDescription>
            One row per model call, with the price stamped at the time it was metered — ${totalCost.toFixed(4)} in
            total.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RunSpendTable rows={spendTableRows} />
        </CardContent>
      </Card>
    ),
  })

  return {
    runId: run.id,
    title: run.summary ?? triggerLabel,
    subtitle: `${agent ? `${agent.name} · ${agent.title} · ` : ''}${triggerLabel} · started ${stamp(run.startedAt)}`,
    status: run.status,
    isOpen: OPEN_STATUSES.has(run.status),
    agent,
    tabs,
  }
}

/** The status chip both hosts put next to the run's title. */
export function runStatusBadge(status: string): ReactNode {
  return <Badge variant={STATUS_BADGES[status] ?? 'outline'}>{status.replace('_', ' ')}</Badge>
}

/**
 * The run flyout, opened from `?run=<id>` on a list surface. Returns null when
 * nothing is selected, so callers can render it unconditionally.
 */
export async function runDrawer({
  tenantId,
  runId,
  basePath,
  tab,
}: {
  tenantId: string
  runId?: string | undefined
  /** The surface the record was opened from; closing returns there. */
  basePath: string
  /** Deep-link straight to a section. */
  tab?: string | undefined
}): Promise<ReactNode> {
  if (!runId) return null
  const view = await loadRunRecord({ tenantId, runId })
  if (!view) return null

  return (
    <RunDrawer
      open
      basePath={basePath}
      title={view.title}
      subtitle={view.subtitle}
      badge={runStatusBadge(view.status)}
      headerActions={
        view.isOpen ? (
          <span className="flex items-center gap-3">
            <LiveToggle defaultOn />
            <StopRunButton runId={view.runId} live={view.status === 'running'} />
          </span>
        ) : undefined
      }
      tabs={view.tabs}
      initialTabKey={tab}
    />
  )
}
