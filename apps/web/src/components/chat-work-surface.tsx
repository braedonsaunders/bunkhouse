'use client'

import * as React from 'react'
import { CheckCircle2, Globe, Loader2, Monitor, Phone, TerminalSquare } from 'lucide-react'
import { Badge, Button, EmptyState, SubtabNav } from '@braedonsaunders/appkit-ui'
import { ComposedAvatar } from '@braedonsaunders/appkit-avatars/react'
import type { AvatarComposition, AvatarPart, AvatarPartCategory } from '@braedonsaunders/appkit-avatars/composition'
import { LiveKitRoom, VideoTrack, useSpeakingParticipants, useTracks } from '@livekit/components-react'
import { ParticipantKind, Track } from 'livekit-client'
import { observeWorkSurfaceAction, workSurfaceAction } from '../app/chat/actions'
import type { ChatWorkSurface as WorkSurface } from '../lib/chat-work-surface'
import { AGENT_SCREEN_TRACK_NAME } from '../lib/agent-screen'
import { ChatDesk } from './chat-desk'
import { CALL_STAGE_AVATAR_SIZE, CallStage, type CallStageScreenView } from './call-stage'

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
  surface: Extract<WorkSurface, { kind: 'browser' }>
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
  personTitle,
  callAvatar,
}: {
  threadId: string | null
  personId: string
  personName: string
  personTitle: string
  callAvatar: ChatCallAvatar
}) {
  const [activeTab, setActiveTab] = React.useState<'work' | 'desktop'>('work')
  const [surface, setSurface] = React.useState<WorkSurface>({ kind: 'idle', runId: null })

  React.useEffect(() => {
    // No conversation means Live work renders its own empty state below. Keep
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

  return (
    <section className="flex size-full min-h-0 flex-col bg-surface" aria-label={`${personName}'s work surfaces`}>
      <div className="shrink-0 border-b border-border px-2">
        <SubtabNav
          ariaLabel={`${personName}'s work surfaces`}
          active={activeTab}
          onSelect={(tab) => setActiveTab(tab === 'desktop' ? 'desktop' : 'work')}
          tabs={[
            {
              key: 'work',
              label: (
                <span className="flex items-center gap-2">
                  <TerminalSquare aria-hidden className="size-4" />
                  Live work
                </span>
              ),
            },
            {
              key: 'desktop',
              label: (
                <span className="flex items-center gap-2">
                  <Monitor aria-hidden className="size-4" />
                  Desktop
                </span>
              ),
            },
          ]}
        />
      </div>

      {activeTab === 'desktop' ? (
        <div className="min-h-0 flex-1">
          <ChatDesk key={personId} personId={personId} personName={personName} />
        </div>
      ) : threadId === null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <EmptyState
            title="Choose a conversation"
            description={`Select or start a conversation to follow ${personName}'s browser, calls, and background work. The Desktop tab remains available at any time.`}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
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
            <LiveBrowserSurface
              threadId={threadId}
              surface={surface}
              fallback={
                surface.frame.fileId ? (
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
                )
              }
            />
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
        <div className="flex min-h-0 flex-1">
          <LiveCallSurface
            threadId={threadId}
            surface={surface}
            personName={personName}
            personTitle={personTitle}
            avatar={callAvatar}
          />
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
          ) : surface.kind === 'desktop' ? (
            <div className="flex min-h-0 flex-1 items-center justify-center p-6">
              <EmptyState
                icon={<Monitor />}
                title="Working at the desktop"
                description={`${personName}'s desktop is active. Open the Desktop tab to watch or take control without losing this run's live-work view.`}
                action={
                  <Button type="button" size="sm" onClick={() => setActiveTab('desktop')}>
                    <Monitor aria-hidden className="size-4" />
                    Open Desktop
                  </Button>
                }
              />
            </div>
          ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <EmptyState
            title="No active work"
            description={`When ${personName} uses a browser, places a call, works headlessly, or opens the desktop, it will appear here automatically.`}
          />
        </div>
          )}
        </div>
      )}
    </section>
  )
}
