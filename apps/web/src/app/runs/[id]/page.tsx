import { notFound } from 'next/navigation'
import { asc, eq, sql } from 'drizzle-orm'
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DetailHeader,
  EmptyState,
  PageContainer,
} from '@appkit/ui'
import { people, runEvents, runs, tokenSpend } from '../../../db/schema'
import { db } from '../../../db/client'
import { resolveTenantId } from '../../../lib/tenant'

export const dynamic = 'force-dynamic'

const STATUS_BADGES: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  completed: 'default',
  running: 'secondary',
  waiting_approval: 'outline',
  waiting_reply: 'outline',
  failed: 'destructive',
  cancelled: 'outline',
}

const KIND_LABELS: Record<string, string> = {
  thought: 'Thought',
  message: 'Message',
  tool_call: 'Tool call',
  tool_result: 'Tool result',
  procedure_citation: 'Procedure cited',
  approval_request: 'Approval requested',
  delegation: 'Delegation',
  error: 'Error',
}

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
    default:
      return 'Manual'
  }
}

function renderPayload(kind: string, payload: Record<string, unknown>): string {
  if (kind === 'message') return String(payload.text ?? '')
  if (kind === 'error') return String(payload.message ?? '')
  if (kind === 'procedure_citation') return `procedure:${payload.slug} v${payload.version}`
  if (kind === 'approval_request') return String(payload.description ?? '')
  if (kind === 'tool_call') return `${payload.toolName}(${JSON.stringify(payload.input ?? {})})`
  if (kind === 'tool_result') return `${payload.toolName} → ${JSON.stringify(payload.output ?? {})}`
  return JSON.stringify(payload)
}

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const tenantId = await resolveTenantId()
  const app = db()

  const data = await app.withTenantContext(tenantId, async () => {
    const [run] = await app.db.select().from(runs).where(eq(runs.id, id))
    if (!run) return null
    const [hand] = await app.db
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
    return { run, hand: hand ?? null, events, spend }
  })

  if (!data) notFound()
  const { run, hand, events, spend } = data
  const unpriced = (spend?.sources ?? []).includes('unpriced')

  return (
    <PageContainer className="space-y-6">
      <DetailHeader
        back={hand ? { href: `/people/${hand.id}`, label: hand.name } : { href: '/', label: 'Home' }}
        title={run.summary ?? describeTrigger(run.trigger)}
        subtitle={`${hand ? `${hand.name} · ${hand.title} · ` : ''}${describeTrigger(run.trigger)} · started ${run.startedAt.toISOString().slice(0, 16).replace('T', ' ')}`}
        badge={<Badge variant={STATUS_BADGES[run.status] ?? 'outline'}>{run.status.replace('_', ' ')}</Badge>}
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

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
          <CardDescription>Append-only record of everything this run did — the audit trail.</CardDescription>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <EmptyState title="No events" description="This run recorded nothing before finishing." />
          ) : (
            <ol className="space-y-2">
              {events.map((event) => (
                <li key={event.id} className="flex gap-3 rounded-md border border-border p-3 text-sm">
                  <div className="w-36 shrink-0 space-y-1">
                    <Badge
                      variant={
                        event.kind === 'error'
                          ? 'destructive'
                          : event.kind === 'approval_request'
                            ? 'outline'
                            : event.kind === 'procedure_citation'
                              ? 'default'
                              : 'secondary'
                      }
                    >
                      {KIND_LABELS[event.kind] ?? event.kind}
                    </Badge>
                    <p className="text-xs text-fg-muted">{event.createdAt.toISOString().slice(11, 19)}</p>
                  </div>
                  <p className="min-w-0 whitespace-pre-wrap break-words text-fg">
                    {renderPayload(event.kind, event.payload)}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  )
}
