import { notFound } from 'next/navigation'
import { asc, eq, inArray, sql } from 'drizzle-orm'
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DetailHeader,
  PageContainer,
} from '@appkit/ui'
import { formatAttachmentSize } from '@appkit/storage'
import { approvals, callSessions, callTurns, files, people, procedureRevisions, procedures, runEvents, runs, tokenSpend } from '../../../db/schema'
import { db } from '../../../db/client'
import { resolveTenantId } from '../../../lib/tenant'
import { toolActivityFromEvents, type CallActivityEvent } from '../../../lib/call-activity'
import { RunDesk, type ApprovalArtifact, type DeskEvent, type ProcedureArtifact } from '../../../components/run-desk'
import { LiveToggle } from '../../../components/live-toggle'

export const dynamic = 'force-dynamic'

const STATUS_BADGES: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  completed: 'default',
  running: 'secondary',
  waiting_approval: 'outline',
  waiting_reply: 'outline',
  failed: 'destructive',
  cancelled: 'outline',
}

const OPEN_STATUSES = new Set(['running', 'waiting_approval', 'waiting_reply'])

function describeTrigger(trigger: Record<string, unknown>): string {
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

export default async function RunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ from?: string }>
}) {
  const { id } = await params
  const { from } = await searchParams
  const tenantId = await resolveTenantId()
  const app = db()

  const data = await app.withTenantContext(tenantId, async () => {
    const [run] = await app.db.select().from(runs).where(eq(runs.id, id))
    if (!run) return null
    const [agent] = await app.db
      .select({ id: people.id, name: people.name, title: people.title })
      .from(people)
      .where(eq(people.id, run.personId))
    const events = await app.db.select().from(runEvents).where(eq(runEvents.runId, id)).orderBy(asc(runEvents.seq))
    const [spend] = await app.db
      .select({
        cost: sql<string>`coalesce(sum(${tokenSpend.costUsd}), 0)`,
        inputTokens: sql<number>`coalesce(sum(${tokenSpend.inputTokens}), 0)`.mapWith(Number),
        outputTokens: sql<number>`coalesce(sum(${tokenSpend.outputTokens}), 0)`.mapWith(Number),
        sources: sql<string[]>`array_agg(distinct ${tokenSpend.priceSource})`,
        models: sql<string[]>`array_agg(distinct ${tokenSpend.model})`,
      })
      .from(tokenSpend)
      .where(eq(tokenSpend.runId, id))

    // The desk's right pane shows artifacts: cited procedure revisions (pinned
    // by slug+version) and the approvals this run is waiting on or received.
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
      })
      .from(approvals)
      .leftJoin(people, eq(people.id, approvals.decidedById))
      .where(eq(approvals.runId, id))
    // A call run carries its transcript ledger as an artifact in the desk.
    const [callSession] = await app.db
      .select({
        id: callSessions.id,
        status: callSessions.status,
        durationSeconds: callSessions.durationSeconds,
        startedAt: callSessions.startedAt,
      })
      .from(callSessions)
      .where(eq(callSessions.runId, id))
    const transcript = callSession
      ? await app.db
          .select({ speaker: callTurns.speaker, text: callTurns.text, atMs: callTurns.atMs })
          .from(callTurns)
          .where(eq(callTurns.sessionId, callSession.id))
          .orderBy(asc(callTurns.seq))
      : null
    const producedFiles = await app.db.select().from(files).where(eq(files.runId, id)).orderBy(asc(files.createdAt))
    return { run, agent: agent ?? null, events, spend, citedProcedures, revisions, approvalRows, callSession: callSession ?? null, transcript, producedFiles }
  })

  if (!data) notFound()
  const { run, agent, events, spend } = data
  const unpriced = (spend?.sources ?? []).includes('unpriced')
  const isOpen = OPEN_STATUSES.has(run.status)

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
  // card can interleave what the agent did with what was said.
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

  return (
    <PageContainer className="space-y-6">
      <DetailHeader
        back={
          from === 'person' && agent
            ? { href: `/organization/agents?person=${agent.id}`, label: agent.name }
            : { href: '/observatory', label: 'Observatory' }
        }
        title={run.summary ?? describeTrigger(run.trigger)}
        subtitle={`${agent ? `${agent.name} · ${agent.title} · ` : ''}${describeTrigger(run.trigger)} · started ${run.startedAt.toISOString().slice(0, 16).replace('T', ' ')}`}
        badge={<Badge variant={STATUS_BADGES[run.status] ?? 'outline'}>{run.status.replace('_', ' ')}</Badge>}
        actions={isOpen ? <LiveToggle defaultOn /> : undefined}
      />

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Cost</CardTitle>
            <CardDescription>
              {(spend?.models ?? []).filter(Boolean).join(', ') || 'no model calls'}
              {unpriced ? ' · contains unpriced spend' : ''}
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            <p className="text-2xl font-semibold tabular-nums">${Number(spend?.cost ?? 0).toFixed(4)}</p>
            <p className="text-fg-muted tabular-nums">
              {spend?.inputTokens ?? 0} in · {spend?.outputTokens ?? 0} out tokens
            </p>
            {unpriced ? <Badge variant="destructive">unpriced — set a price in Settings</Badge> : null}
          </CardContent>
        </Card>
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Outcome</CardTitle>
          </CardHeader>
          <CardContent className="whitespace-pre-wrap text-sm">{run.summary ?? 'Still working…'}</CardContent>
        </Card>
      </div>

      {data.producedFiles.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Work product</CardTitle>
            <CardDescription>Files this run produced or received — the real deliverables, kept on the record.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {data.producedFiles.map((file) => (
              <a
                key={file.id}
                href={`/api/files/${file.id}`}
                download={file.filename}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg transition-colors hover:bg-surface-hover"
              >
                <span className="font-medium">{file.filename}</span>
                <span className="text-fg-muted">{formatAttachmentSize(file.sizeBytes)}</span>
              </a>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <RunDesk
        events={deskEvents}
        procedures={procedureArtifacts}
        approvals={approvalArtifacts}
        {...(data.transcript ? { transcript: data.transcript, callActivity, agentName: agent?.name ?? 'Agent' } : {})}
      />
    </PageContainer>
  )
}
