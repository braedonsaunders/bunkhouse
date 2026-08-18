'use client'

import * as React from 'react'
import Link from 'next/link'
import { CheckCircle2, ChevronRight, Download, FileText, Globe, History as HistoryIcon, Image as ImageIcon, Loader2, Monitor, MonitorUp, TerminalSquare } from 'lucide-react'
import { Badge, Button, EmptyState, SubtabNav, cn } from '@braedonsaunders/appkit-ui'
import { LiveKitRoom, VideoTrack, useTracks } from '@livekit/components-react'
import { Track } from 'livekit-client'
import { observeRemoteWorkSurfaceAction, observeWorkSurfaceAction, workSurfaceAction } from '../app/chat/actions'
import type { ChatBrowserWorkSurface, ChatWorkFile, ChatWorkSurface as WorkSurface } from '../lib/chat-work-surface'
import { RemoteComputerViewer, TerminalSurface } from '@braedonsaunders/appkit-remote-sessions/react'
import type { RemoteProtocol } from '@braedonsaunders/appkit-remote-sessions'
import { AGENT_SCREEN_TRACK_NAME } from '../lib/agent-screen'
import { ChatDesk } from './chat-desk'
import { WorkSurfaceFullscreenButton } from './work-surface-fullscreen-button'

type ObserverCredential = { serverUrl: string; token: string }

function useObserverCredential(args: {
  threadId: string
  runId: string
  kind: 'browser'
}): { room: ObserverCredential | null; error: string | null } {
  const { threadId, runId, kind } = args
  const key = `${threadId}:${runId}:${kind}`
  const [result, setResult] = React.useState<{
    key: string
    room: ObserverCredential | null
    error: string | null
  }>({ key: '', room: null, error: null })
  React.useEffect(() => {
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | null = null
    const observe = () => {
      observeWorkSurfaceAction({ threadId, runId, kind }).then(
        (credential) => {
          if (cancelled) return
          setResult({ key, room: credential, error: null })
          // Refresh before the one-hour observer grant expires so a long run
          // can reconnect after a transient network drop without remounting.
          retry = setTimeout(observe, 50 * 60 * 1_000)
        },
        (reason: unknown) => {
          if (cancelled) return
          setResult({
            key,
            room: null,
            error: reason instanceof Error ? reason.message : 'The live view could not be opened.',
          })
          retry = setTimeout(observe, 3_000)
        },
      )
    }
    observe()
    return () => {
      cancelled = true
      if (retry) clearTimeout(retry)
    }
  }, [key, kind, runId, threadId])
  return result.key === key ? { room: result.room, error: result.error } : { room: null, error: null }
}

function AgentScreenTrack({ fallback }: { fallback: React.ReactNode }) {
  const tracks = useTracks([Track.Source.ScreenShare], { onlySubscribed: true })
  const screen = tracks.find((track) => track.publication.trackName === AGENT_SCREEN_TRACK_NAME) ?? null
  return screen ? <VideoTrack trackRef={screen} className="size-full object-contain object-top" /> : fallback
}

function LiveBrowserSurface({
  threadId,
  surface,
  fallback,
}: {
  threadId: string
  surface: ChatBrowserWorkSurface
  fallback: React.ReactNode
}) {
  const { room } = useObserverCredential({ threadId, runId: surface.runId, kind: 'browser' })
  if (!room) return fallback
  return (
    <LiveKitRoom serverUrl={room.serverUrl} token={room.token} audio={false} video={false} connect className="size-full">
      <AgentScreenTrack fallback={fallback} />
    </LiveKitRoom>
  )
}

function statusLabel(status: string): string {
  if (status === 'running' || status === 'active') return 'Live'
  if (status === 'waiting_approval') return 'Waiting for approval'
  if (status === 'waiting_reply') return 'Waiting for reply'
  return status.replaceAll('_', ' ')
}

function useSurfaceExpansion() {
  const [expanded, setExpanded] = React.useState(false)
  React.useEffect(() => {
    if (!expanded) return
    const previousOverflow = document.body.style.overflow
    const collapse = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false)
    }
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', collapse)
    return () => {
      document.removeEventListener('keydown', collapse)
      document.body.style.overflow = previousOverflow
    }
  }, [expanded])
  return { expanded, toggle: () => setExpanded((current) => !current) }
}

function ExpandableTerminalSurface(props: React.ComponentProps<typeof TerminalSurface>) {
  const { expanded, toggle } = useSurfaceExpansion()
  const { headerActions, ...surfaceProps } = props
  return (
    <div
      data-ui-overlay={expanded ? 'terminal-fullscreen' : undefined}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded ? true : undefined}
      aria-label={expanded ? `${props.title}, fullscreen` : undefined}
      className={expanded ? 'fixed inset-0 z-[60] flex flex-col bg-surface' : 'contents'}
    >
      <TerminalSurface
        {...surfaceProps}
        headerActions={(
          <>
            {headerActions}
            <WorkSurfaceFullscreenButton expanded={expanded} onToggle={toggle} surface="terminal" />
          </>
        )}
      />
    </div>
  )
}

function BrowserWorkStage({
  threadId,
  surface,
  personName,
}: {
  threadId: string
  surface: ChatBrowserWorkSurface
  personName: string
}) {
  const { expanded, toggle } = useSurfaceExpansion()
  const fallback = surface.frame.fileId ? (
    // A ledgered browser frame is already encoded at its capture size.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/api/files/${encodeURIComponent(surface.frame.fileId)}`}
      alt={`${personName}'s browser, showing ${surface.frame.title}`}
      className="size-full object-contain object-top"
    />
  ) : (
    <p className="flex size-full items-center justify-center px-6 text-center text-sm text-fg-muted">
      This browser step remains on the run record, but it did not carry a frame.
    </p>
  )
  return (
    <div
      data-ui-overlay={expanded ? 'browser-fullscreen' : undefined}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded ? true : undefined}
      aria-label={expanded ? `${personName}'s browser, fullscreen` : undefined}
      className={expanded ? 'fixed inset-0 z-[60] flex flex-col bg-surface' : 'flex min-h-0 flex-1 flex-col'}
    >
      <div className="flex min-w-0 items-center gap-2 border-b border-border bg-bg-subtle px-3 py-2">
        <Globe aria-hidden className="size-4 shrink-0 text-fg-muted" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">{surface.frame.title}</p>
          {surface.frame.url ? <p className="truncate text-xs text-fg-muted">{surface.frame.url}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge variant="secondary">{statusLabel(surface.status)}</Badge>
          <WorkSurfaceFullscreenButton expanded={expanded} onToggle={toggle} surface="browser" />
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-bg-subtle">
        {surface.status === 'active' ? <LiveBrowserSurface threadId={threadId} surface={surface} fallback={fallback} /> : fallback}
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
  )
}

function fileSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${Math.max(0.1, bytes / 1_024).toFixed(1)} KB`
  return `${Math.max(0.1, bytes / 1_048_576).toFixed(1)} MB`
}

function canPreview(file: ChatWorkFile): boolean {
  return file.contentType === 'application/pdf' || /^image\/(?:png|jpeg|gif|webp)$/.test(file.contentType)
}

/** The conversation's real immutable work product, with safe image/PDF viewing. */
function FilesWorkStage({ files, personName }: { files: ChatWorkFile[]; personName: string }) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const selected = files.find((file) => file.id === selectedId) ?? files[0] ?? null

  if (files.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <EmptyState
          icon={<FileText />}
          title="No files in this conversation yet"
          description={`${personName}'s documents, spreadsheets, attachments, images, and PDFs will collect here as the work develops.`}
        />
      </div>
    )
  }

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] bg-bg-subtle">
      <div className="app-scroll flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-surface p-2">
        {files.map((file) => (
          <button
            key={file.id}
            type="button"
            onClick={() => setSelectedId(file.id)}
            className={cn(
              'flex min-w-40 max-w-56 items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
              selected?.id === file.id ? 'bg-primary-subtle text-fg' : 'text-fg-muted hover:bg-surface-hover hover:text-fg',
            )}
          >
            {file.contentType.startsWith('image/') ? <ImageIcon aria-hidden className="size-4 shrink-0" /> : <FileText aria-hidden className="size-4 shrink-0" />}
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium">{file.filename}</span>
              <span className="block text-[11px] text-fg-subtle">{fileSize(file.sizeBytes)}</span>
            </span>
          </button>
        ))}
      </div>
      {selected ? (
        <div className="flex min-h-0 flex-col">
          <div className="flex min-w-0 items-center gap-2 border-b border-border bg-surface px-3 py-2">
            <FileText aria-hidden className="size-4 shrink-0 text-fg-muted" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-fg">{selected.filename}</p>
              <p className="truncate text-xs text-fg-muted">{selected.contentType} · {fileSize(selected.sizeBytes)}</p>
            </div>
            <Button asChild type="button" variant="ghost" size="icon" className="size-7 shrink-0">
              <a href={`/api/files/${encodeURIComponent(selected.id)}`} aria-label={`Download ${selected.filename}`} title="Download">
                <Download aria-hidden className="size-4" />
              </a>
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden bg-bg-subtle">
            {canPreview(selected) ? (
              selected.contentType.startsWith('image/') ? (
                // The file route authenticates and tenant-scopes every read.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/files/${encodeURIComponent(selected.id)}?preview=1`} alt={selected.filename} className="size-full object-contain p-3" />
              ) : (
                <iframe src={`/api/files/${encodeURIComponent(selected.id)}?preview=1`} title={selected.filename} className="size-full border-0" />
              )
            ) : (
              <div className="flex size-full items-center justify-center p-6 text-center">
                <div>
                  <FileText aria-hidden className="mx-auto mb-3 size-8 text-fg-subtle" />
                  <p className="text-sm font-medium text-fg">Preview is not available for this file type</p>
                  <p className="mt-1 text-xs text-fg-muted">Download the original to open it in its native application.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function ChatWorkSurface({
  threadId,
  personId,
  personName,
}: {
  threadId: string | null
  personId: string
  personName: string
}) {
  const [activeTab, setActiveTab] = React.useState<'desktop' | 'browser' | 'terminal' | 'files' | 'remote' | 'history'>('desktop')
  const [surface, setSurface] = React.useState<WorkSurface>({ kind: 'idle', runId: null, history: [], remote: null, recentBrowser: null, recentTerminal: null, files: [], focus: null })
  const followedSurfaceRef = React.useRef('idle')

  React.useEffect(() => {
    // No conversation means History renders its own empty state below. Keep
    // the last observation in memory so a brief deselection does not create a
    // second render or flash an idle header before another thread is chosen.
    if (threadId === null) return
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

  React.useEffect(() => {
    if (!surface.focus || surface.focus.key === followedSurfaceRef.current) return
    followedSurfaceRef.current = surface.focus.key
    setActiveTab(surface.focus.tab)
  }, [surface.focus])

  return (
    <section className="flex size-full min-h-0 flex-col bg-surface" aria-label={`${personName}'s work surfaces`}>
      <div className="shrink-0 border-b border-border px-2">
        <SubtabNav
          ariaLabel={`${personName}'s work surfaces`}
          active={activeTab}
          onSelect={(tab) => setActiveTab(tab as typeof activeTab)}
          className="h-12 gap-0 overflow-x-hidden [&>button]:!h-12 [&>button]:!min-w-0 [&>button]:!flex-1 [&>button]:!shrink [&>button]:!justify-center [&>button]:!gap-1 [&>button]:!px-1.5 [&>button]:!py-0 [&>button]:!text-xs"
          tabs={[
            {
              key: 'desktop',
              label: (
                <span className="flex min-w-0 items-center gap-1">
                  <Monitor aria-hidden className="size-3.5 shrink-0" />
                  <span className="truncate">Desktop</span>
                </span>
              ),
            },
            {
              key: 'browser',
              label: <span className="flex min-w-0 items-center gap-1"><Globe aria-hidden className="size-3.5 shrink-0" /><span className="truncate">Browser</span></span>,
            },
            {
              key: 'terminal',
              label: <span className="flex min-w-0 items-center gap-1"><TerminalSquare aria-hidden className="size-3.5 shrink-0" /><span className="truncate">Terminal</span></span>,
            },
            {
              key: 'files',
              label: <span className="flex min-w-0 items-center gap-1"><FileText aria-hidden className="size-3.5 shrink-0" /><span className="truncate">Files</span></span>,
            },
            ...(surface.remote ? [{
              key: 'remote',
              label: <span className="flex min-w-0 items-center gap-1"><MonitorUp aria-hidden className="size-3.5 shrink-0" /><span className="truncate">{surface.remote.computerName}</span></span>,
            }] : []),
            {
              key: 'history',
              label: (
                <span className="flex min-w-0 items-center gap-1">
                  <HistoryIcon aria-hidden className="size-3.5 shrink-0" />
                  <span className="truncate">History</span>
                </span>
              ),
            },
          ]}
        />
      </div>

      {activeTab === 'browser' && threadId !== null && (surface.kind === 'browser' || surface.recentBrowser) ? (
        <BrowserWorkStage threadId={threadId} surface={surface.kind === 'browser' ? surface : surface.recentBrowser!} personName={personName} />
      ) : activeTab === 'browser' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <EmptyState icon={<Globe />} title="Browser ready" description={`${personName}'s graphical browser appears here whenever they use it.`} />
        </div>
      ) : activeTab === 'terminal' && (surface.kind === 'terminal' || surface.recentTerminal) ? (
        <ExpandableTerminalSurface
          title={(surface.kind === 'terminal' ? surface : surface.recentTerminal!).terminal.title}
          subtitle={`Real output from ${personName}’s Desk · recorded on the run`}
          cwd={(surface.kind === 'terminal' ? surface : surface.recentTerminal!).terminal.cwd}
          status={(surface.kind === 'terminal' ? surface : surface.recentTerminal!).terminal.status}
          entries={(surface.kind === 'terminal' ? surface : surface.recentTerminal!).terminal.entries}
        />
      ) : activeTab === 'terminal' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <EmptyState icon={<TerminalSquare />} title="Terminal ready" description={`Commands and real output from ${personName}'s machine appear here as they work.`} />
        </div>
      ) : activeTab === 'files' ? (
        <FilesWorkStage files={surface.files} personName={personName} />
      ) : activeTab === 'remote' && threadId !== null && surface.remote ? (
        surface.remote.terminal ? (
          <ExpandableTerminalSurface
            title={surface.remote.terminal.title}
            subtitle={surface.remote.terminal.subtitle}
            cwd={surface.remote.terminal.cwd}
            status={surface.remote.terminal.status}
            entries={surface.remote.terminal.entries}
          />
        ) : (
          <RemoteComputerViewer
            key={surface.remote.sessionId}
            targetName={surface.remote.computerName}
            protocol={surface.remote.protocol as RemoteProtocol}
            scope="observe"
            connect={() => observeRemoteWorkSurfaceAction({ threadId, sessionId: surface.remote!.sessionId })}
          />
        )
      ) : activeTab === 'desktop' ? (
        <div className="min-h-0 flex-1">
          <ChatDesk key={personId} personId={personId} personName={personName} />
        </div>
      ) : threadId === null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <EmptyState
            title="Choose a conversation"
            description={`Select or start a conversation to see ${personName}'s durable execution history.`}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-fg">
              <HistoryIcon aria-hidden className="size-4" />
              <span>Conversation history</span>
            </div>
            {surface.history.length ? <Badge variant="secondary">{surface.history.length} steps</Badge> : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {surface.history.length ? (
              <ol className="space-y-0.5">
                {surface.history.map((event) => (
                  <li key={event.id}>
                    <Link
                      href={`/organization/${personId}?section=chat&thread=${encodeURIComponent(threadId)}&run=${event.runId}&runTab=activity`}
                      scroll={false}
                      className="group flex min-h-8 items-center gap-2 rounded-md px-2 text-xs hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Open work details for ${event.label}`}
                    >
                      <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                      <span className="min-w-0 flex-1 truncate text-fg">{event.label}</span>
                      <time className="shrink-0 tabular-nums text-fg-subtle" dateTime={event.at} suppressHydrationWarning>
                        {new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </time>
                      <ChevronRight aria-hidden className="size-3.5 shrink-0 text-fg-subtle transition-colors group-hover:text-fg" />
                    </Link>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-fg-muted">
                No recorded steps yet.
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
