'use client'

import * as React from 'react'
import Link from 'next/link'
import { CheckCircle2, ChevronRight, Globe, History as HistoryIcon, Loader2, Monitor, MonitorUp, Phone, TerminalSquare } from 'lucide-react'
import { Badge, EmptyState, SubtabNav } from '@braedonsaunders/appkit-ui'
import { ComposedAvatar } from '@braedonsaunders/appkit-avatars/react'
import type { AvatarComposition, AvatarPart, AvatarPartCategory } from '@braedonsaunders/appkit-avatars/composition'
import { LiveKitRoom, VideoTrack, useSpeakingParticipants, useTracks } from '@livekit/components-react'
import { ParticipantKind, Track } from 'livekit-client'
import { observeRemoteWorkSurfaceAction, observeWorkSurfaceAction, workSurfaceAction } from '../app/chat/actions'
import type { ChatBrowserWorkSurface, ChatWorkSurface as WorkSurface } from '../lib/chat-work-surface'
import { RemoteComputerViewer, TerminalSurface } from '@braedonsaunders/appkit-remote-sessions/react'
import type { RemoteProtocol } from '@braedonsaunders/appkit-remote-sessions'
import { AGENT_SCREEN_TRACK_NAME } from '../lib/agent-screen'
import { ChatDesk } from './chat-desk'
import { CALL_STAGE_AVATAR_SIZE, CallStage, type CallStageScreenView } from './call-stage'
import { WorkSurfaceFullscreenButton } from './work-surface-fullscreen-button'

export type ChatCallAvatar = {
  composition: AvatarComposition | null
  parts: AvatarPart[]
  categories: AvatarPartCategory[]
}

type ObserverCredential = { serverUrl: string; token: string }

function useObserverCredential(args: {
  threadId: string
  runId: string
  kind: 'browser' | 'call'
  sessionId?: string
}): { room: ObserverCredential | null; error: string | null } {
  const { threadId, runId, kind, sessionId } = args
  const key = `${threadId}:${runId}:${kind}:${sessionId ?? ''}`
  const [result, setResult] = React.useState<{
    key: string
    room: ObserverCredential | null
    error: string | null
  }>({ key: '', room: null, error: null })
  React.useEffect(() => {
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | null = null
    const observe = () => {
      observeWorkSurfaceAction({ threadId, runId, kind, ...(sessionId ? { sessionId } : {}) }).then(
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
  }, [key, kind, runId, sessionId, threadId])
  return result.key === key ? { room: result.room, error: result.error } : { room: null, error: null }
}

function AgentStageAvatar({ personName, avatar }: { personName: string; avatar: ChatCallAvatar }) {
  if (!avatar.composition) {
    return (
      <div
        role="img"
        aria-label={personName}
        style={{ width: CALL_STAGE_AVATAR_SIZE, height: CALL_STAGE_AVATAR_SIZE }}
        className="flex items-center justify-center rounded-full border border-border bg-primary-subtle text-primary"
      >
        <span className="text-8xl font-semibold">{personName.charAt(0).toUpperCase()}</span>
      </div>
    )
  }
  return (
    <ComposedAvatar
      composition={avatar.composition}
      parts={avatar.parts}
      categories={avatar.categories}
      variant="head"
      size={CALL_STAGE_AVATAR_SIZE}
      rounded
      animate="idle"
      name={personName}
    />
  )
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

function useElapsedSince(startedAt: string): number {
  const started = React.useMemo(() => new Date(startedAt).getTime(), [startedAt])
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  return Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : 0
}

function ObservedCallStage({
  personName,
  personTitle,
  avatar,
  startedAt,
}: {
  personName: string
  personTitle: string
  avatar: ChatCallAvatar
  startedAt: string
}) {
  const screenTracks = useTracks([Track.Source.ScreenShare], { onlySubscribed: true })
  const agentScreen = screenTracks.find((track) => track.publication.trackName === AGENT_SCREEN_TRACK_NAME) ?? null
  // An observer sees both sides of the room. Attribute the halo only to the
  // LiveKit Agents participant, never to the human or SIP caller speaking.
  const speaking = useSpeakingParticipants().some((participant) => participant.kind === ParticipantKind.AGENT)
  const elapsedSeconds = useElapsedSince(startedAt)
  const screen = React.useMemo<CallStageScreenView | null>(
    () =>
      agentScreen
        ? {
            live: true,
            video: <VideoTrack trackRef={agentScreen} />,
            imageUrl: null,
            title: 'Working at the desk',
            host: null,
            action: 'Live from the call',
            atSeconds: elapsedSeconds,
            frameKey: agentScreen.publication.trackSid ?? 'live',
          }
        : null,
    [agentScreen, elapsedSeconds],
  )
  return (
    <div className="flex size-full min-h-0 flex-col p-4">
      <CallStage
        name={personName}
        title={personTitle}
        phase="live"
        speaking={speaking}
        elapsedSeconds={elapsedSeconds}
        status="Live call · observer view"
        screen={screen}
        avatar={<AgentStageAvatar personName={personName} avatar={avatar} />}
      />
    </div>
  )
}

function LiveCallSurface({
  threadId,
  surface,
  personName,
  personTitle,
  avatar,
}: {
  threadId: string
  surface: Extract<WorkSurface, { kind: 'call' }>
  personName: string
  personTitle: string
  avatar: ChatCallAvatar
}) {
  const { room, error } = useObserverCredential({
    threadId,
    runId: surface.runId,
    kind: 'call',
    sessionId: surface.sessionId,
  })
  if (error) {
    return <p className="m-auto max-w-xs px-6 text-center text-sm text-fg-muted">{error}</p>
  }
  if (!room) {
    return (
      <span className="m-auto flex items-center gap-2 text-sm text-fg-muted">
        <Loader2 aria-hidden className="size-4 animate-spin" /> Joining the live stage…
      </span>
    )
  }
  return (
    <LiveKitRoom serverUrl={room.serverUrl} token={room.token} audio={false} video={false} connect className="size-full min-h-0">
      <ObservedCallStage personName={personName} personTitle={personTitle} avatar={avatar} startedAt={surface.startedAt} />
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

export function ChatWorkSurface({
  threadId,
  personId,
  personName,
  personTitle,
  callAvatar,
}: {
  threadId: string | null
  personId: string
  personName: string
  personTitle: string
  callAvatar: ChatCallAvatar
}) {
  const [activeTab, setActiveTab] = React.useState<'desktop' | 'browser' | 'terminal' | 'call' | 'remote' | 'history'>('desktop')
  const [surface, setSurface] = React.useState<WorkSurface>({ kind: 'idle', runId: null, history: [], remote: null, recentBrowser: null, recentTerminal: null })
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
    const suggested = surface.kind !== 'call' && surface.remote
      ? 'remote'
      : surface.kind === 'browser' || surface.kind === 'terminal' || surface.kind === 'call' || surface.kind === 'desktop'
        ? surface.kind
        : null
    if (!suggested) return
    const key = `${suggested}:${surface.runId ?? ''}${surface.remote ? `:${surface.remote.sessionId}` : ''}`
    if (key === followedSurfaceRef.current) return
    followedSurfaceRef.current = key
    setActiveTab(suggested)
  }, [surface])

  return (
    <section className="flex size-full min-h-0 flex-col bg-surface" aria-label={`${personName}'s work surfaces`}>
      <div className="shrink-0 border-b border-border px-2">
        <SubtabNav
          ariaLabel={`${personName}'s work surfaces`}
          active={activeTab}
          onSelect={(tab) => setActiveTab(tab as typeof activeTab)}
          tabs={[
            {
              key: 'desktop',
              label: (
                <span className="flex items-center gap-2">
                  <Monitor aria-hidden className="size-4" />
                  Desktop
                </span>
              ),
            },
            ...(surface.kind === 'browser' || surface.recentBrowser ? [{
              key: 'browser',
              label: <span className="flex items-center gap-2"><Globe aria-hidden className="size-4" />Browser</span>,
            }] : []),
            ...(surface.kind === 'terminal' || surface.recentTerminal ? [{
              key: 'terminal',
              label: <span className="flex items-center gap-2"><TerminalSquare aria-hidden className="size-4" />Terminal</span>,
            }] : []),
            ...(surface.kind === 'call' ? [{
              key: 'call',
              label: <span className="flex items-center gap-2"><Phone aria-hidden className="size-4" />Call</span>,
            }] : []),
            ...(surface.remote ? [{
              key: 'remote',
              label: <span className="flex items-center gap-2"><MonitorUp aria-hidden className="size-4" />{surface.remote.computerName}</span>,
            }] : []),
            {
              key: 'history',
              label: (
                <span className="flex items-center gap-2">
                  <HistoryIcon aria-hidden className="size-4" />
                  History
                </span>
              ),
            },
          ]}
        />
      </div>

      {activeTab === 'browser' && threadId !== null && (surface.kind === 'browser' || surface.recentBrowser) ? (
        <BrowserWorkStage threadId={threadId} surface={surface.kind === 'browser' ? surface : surface.recentBrowser!} personName={personName} />
      ) : activeTab === 'terminal' && (surface.kind === 'terminal' || surface.recentTerminal) ? (
        <ExpandableTerminalSurface
          title={(surface.kind === 'terminal' ? surface : surface.recentTerminal!).terminal.title}
          subtitle={`Real output from ${personName}’s Desk · recorded on the run`}
          cwd={(surface.kind === 'terminal' ? surface : surface.recentTerminal!).terminal.cwd}
          status={(surface.kind === 'terminal' ? surface : surface.recentTerminal!).terminal.status}
          entries={(surface.kind === 'terminal' ? surface : surface.recentTerminal!).terminal.entries}
        />
      ) : activeTab === 'call' && threadId !== null && surface.kind === 'call' ? (
        <div className="flex min-h-0 flex-1">
          <LiveCallSurface
            threadId={threadId}
            surface={surface}
            personName={personName}
            personTitle={personTitle}
            avatar={callAvatar}
          />
        </div>
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
