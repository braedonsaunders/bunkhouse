'use client'

import * as React from 'react'
import { CheckCircle2, Globe, Loader2, Monitor, Phone, TerminalSquare } from 'lucide-react'
import { Badge, EmptyState } from '@braedonsaunders/appkit-ui'
import { workSurfaceAction } from '../app/chat/actions'
import type { ChatWorkSurface as WorkSurface } from '../lib/chat-work-surface'
import { ChatDesk } from './chat-desk'

function statusLabel(status: string): string {
  if (status === 'running' || status === 'active') return 'Live'
  if (status === 'waiting_approval') return 'Waiting for approval'
  if (status === 'waiting_reply') return 'Waiting for reply'
  return status.replaceAll('_', ' ')
}

function SurfaceHeader({ surface, personName }: { surface: WorkSurface; personName: string }) {
  const icon =
    surface.kind === 'browser' ? <Globe aria-hidden className="size-4" />
    : surface.kind === 'call' ? <Phone aria-hidden className="size-4" />
    : surface.kind === 'desktop' ? <Monitor aria-hidden className="size-4" />
    : <TerminalSquare aria-hidden className="size-4" />
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
      <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-fg">
        {icon}
        <span className="truncate">{personName}&apos;s work</span>
      </div>
      {surface.kind !== 'idle' ? <Badge variant="secondary">{statusLabel(surface.status)}</Badge> : null}
    </div>
  )
}

export function ChatWorkSurface({
  threadId,
  personId,
  personName,
}: {
  threadId: string
  personId: string
  personName: string
}) {
  const [surface, setSurface] = React.useState<WorkSurface>({ kind: 'idle', runId: null })

  React.useEffect(() => {
    let stopped = false
    const refresh = async () => {
      try {
        const next = await workSurfaceAction(threadId)
        if (!stopped) setSurface(next)
      } catch {
        // The next tick re-reads durable state; a transient request does not blank the stage.
      }
    }
    void refresh()
    const timer = setInterval(refresh, 1_000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [threadId])

  if (surface.kind === 'desktop') {
    return <ChatDesk key={personId} personId={personId} personName={personName} />
  }

  return (
    <section className="flex size-full min-h-0 flex-col bg-surface" aria-label={`${personName}'s active work`}>
      <SurfaceHeader surface={surface} personName={personName} />
      {surface.kind === 'browser' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2 border-b border-border bg-bg-subtle px-3 py-2">
            <Globe aria-hidden className="size-4 shrink-0 text-fg-muted" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-fg">{surface.frame.title}</p>
              {surface.frame.url ? <p className="truncate text-xs text-fg-muted">{surface.frame.url}</p> : null}
            </div>
          </div>
          <div className="relative min-h-0 flex-1 overflow-hidden bg-bg-subtle">
            {surface.frame.fileId ? (
              // A ledgered browser frame is already encoded at its capture size.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/files/${encodeURIComponent(surface.frame.fileId)}`}
                alt={`${personName}'s browser, showing ${surface.frame.title}`}
                className="size-full object-contain object-top"
              />
            ) : (
              <p className="flex size-full items-center justify-center px-6 text-center text-sm text-fg-muted">
                This browser step could not be captured. Its action remains on the run record.
              </p>
            )}
            <div className="absolute inset-x-3 bottom-3 flex items-center gap-2 rounded-full border border-border bg-surface/90 px-3 py-2 text-xs text-fg shadow-sm backdrop-blur">
              {surface.status === 'active' ? (
                <Loader2 aria-hidden className="size-3.5 animate-spin text-primary" />
              ) : (
                <CheckCircle2 aria-hidden className="size-3.5 text-success" />
              )}
              <span className="truncate">{surface.frame.action}</span>
            </div>
          </div>
        </div>
      ) : surface.kind === 'call' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="flex max-w-xs flex-col items-center gap-3 text-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-primary-subtle text-primary">
              <Phone aria-hidden className="size-6" />
            </span>
            <div>
              <p className="font-medium text-fg">Call in progress</p>
              <p className="mt-1 text-sm text-fg-muted">
                {personName} is working on a {surface.direction.replaceAll('_', ' ')} call. The transcript and decisions are being recorded on this run.
              </p>
            </div>
          </div>
        </div>
      ) : surface.kind === 'activity' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {surface.events.length ? (
            <ol className="space-y-3">
              {surface.events.map((event) => (
                <li key={`${event.kind}:${event.seq}`} className="flex gap-3 text-sm">
                  <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
                  <div className="min-w-0">
                    <p className="break-words text-fg">{event.label}</p>
                    <p className="mt-0.5 text-xs text-fg-muted" suppressHydrationWarning>
                      {new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="flex h-full items-center justify-center">
              <span className="flex items-center gap-2 text-sm text-fg-muted">
                {surface.status === 'running' ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
                {surface.status === 'running' ? `${personName} is getting started…` : 'No tool activity was recorded.'}
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <EmptyState
            title="No active work"
            description={`When ${personName} uses a browser, places a call, works headlessly, or opens the desktop, it will appear here automatically.`}
          />
        </div>
      )}
    </section>
  )
}
