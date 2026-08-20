'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Badge, Card, CardContent, EmptyState } from '@braedonsaunders/appkit-ui'
import { ObservatoryList, type ObservatoryRunRow } from './observatory-list'
import { SectionTabs } from './section-tabs'

export type ActiveRunCardRow = {
  id: string
  agent: string
  agentTitle: string
  /** The agent's figure, cropped to its head viewport by the caller. */
  avatar: React.ReactNode
  trigger: string
  status: 'running' | 'waiting_approval' | 'waiting_reply' | 'waiting_credential'
  statusLabel: string
  summary: string
  /** What the ledger says the agent is doing right now, human-phrased. */
  now: string | null
  /** ISO timestamp the run started, for the elapsed clock. */
  startedAt: string
  cost: string
}

const STATUS_VARIANT: Record<ActiveRunCardRow['status'], 'secondary' | 'outline'> = {
  running: 'secondary',
  waiting_approval: 'outline',
  waiting_reply: 'outline',
  waiting_credential: 'outline',
}

const PULSE_TONE: Record<ActiveRunCardRow['status'], string> = {
  running: 'bg-success',
  waiting_approval: 'bg-warning',
  waiting_reply: 'bg-info',
  waiting_credential: 'bg-info',
}

/**
 * A shared clock for the elapsed counters. First paint uses the server's
 * render time so hydration matches, then ticks on the client.
 */
function useNowMs(renderedAt: string): number {
  const [now, setNow] = React.useState(() => new Date(renderedAt).getTime())
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

function formatElapsed(startedAt: string, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - new Date(startedAt).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function ActiveRunCard({ row, nowMs, basePath }: { row: ActiveRunCardRow; nowMs: number; basePath: string }) {
  const router = useRouter()
  return (
    <Card
      interactive
      onClick={() => router.push(`${basePath}?run=${row.id}`, { scroll: false })}
      className="cursor-pointer"
    >
      <CardContent className="flex h-full flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <span className="flex min-w-0 items-center gap-3">
            {row.avatar}
            <span className="min-w-0">
              <span className="block truncate font-semibold text-primary">{row.agent}</span>
              <span className="block truncate text-xs text-fg-muted">{row.agentTitle}</span>
            </span>
          </span>
          <Badge variant={STATUS_VARIANT[row.status]}>{row.statusLabel}</Badge>
        </div>

        <p className="line-clamp-2 text-sm text-fg">{row.summary}</p>

        <p className="flex items-center gap-2 text-sm text-fg-muted">
          <span className={`inline-block h-2 w-2 shrink-0 animate-pulse rounded-full ${PULSE_TONE[row.status]}`} aria-hidden />
          <span className="line-clamp-2 min-w-0">{row.now ?? 'Working…'}</span>
        </p>

        <p className="mt-auto flex items-center gap-2 text-xs text-fg-muted">
          <span>{row.trigger}</span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">{formatElapsed(row.startedAt, nowMs)} elapsed</span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">{row.cost}</span>
        </p>
      </CardContent>
    </Card>
  )
}

/**
 * The observatory floor: one big card per run in flight — who's working, what
 * they're doing this second, and what it's cost so far. Finished runs live in
 * the History subtab. Always live: server data re-fetches every five seconds,
 * except while a run record is open — that flyout carries its own live switch.
 */
export function ObservatoryFloor({
  active,
  history,
  renderedAt,
  basePath,
  recordOpen = false,
}: {
  active: ActiveRunCardRow[]
  history: ObservatoryRunRow[]
  renderedAt: string
  /** The surface a run record opens over; closing the flyout returns here. */
  basePath: string
  /** A run record is open over the floor, so the floor stops polling. */
  recordOpen?: boolean
}) {
  const router = useRouter()
  const [tab, setTab] = React.useState('live')
  const nowMs = useNowMs(renderedAt)

  React.useEffect(() => {
    if (recordOpen) return
    const timer = setInterval(() => router.refresh(), 5000)
    return () => clearInterval(timer)
  }, [router, recordOpen])

  return (
    <div className="space-y-6">
      <SectionTabs
        tabs={[
          { key: 'live', label: 'Live', count: active.length },
          { key: 'history', label: 'History', count: history.length },
        ]}
        active={tab}
        onSelect={setTab}
        ariaLabel="Activity sections"
      />
      {tab === 'live' ? (
        active.length ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {active.map((row) => (
              <ActiveRunCard key={row.id} row={row} nowMs={nowMs} basePath={basePath} />
            ))}
          </div>
        ) : (
          <EmptyState
            title="No one is on the floor right now"
            description="Live runs appear here the moment an agent starts working — from mail, duties, chat, or delegation."
          />
        )
      ) : (
        <ObservatoryList rows={history} basePath={basePath} />
      )}
    </div>
  )
}
