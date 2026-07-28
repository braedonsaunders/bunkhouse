'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Mic, MicOff, PhoneOff } from 'lucide-react'
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useConnectionState,
  useLocalParticipant,
  useRemoteParticipants,
} from '@livekit/components-react'
import { ConnectionState } from 'livekit-client'
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader } from '@appkit/ui'
import { ComposedAvatar } from '@appkit/avatars/react'
import type { AvatarComposition, AvatarPart, AvatarPartCategory } from '@appkit/avatars/composition'
import { endCallAction, getCallTranscriptAction, type TranscriptTurn } from '../app/call/actions'
import { toolActivityFromEvents, type CallActivityEvent, type ToolActivityItem } from '../lib/call-activity'
import { ToolActivityCard } from './tool-activity'

const CONNECTION_LABELS: Record<string, string> = {
  [ConnectionState.Connecting]: 'connecting',
  [ConnectionState.Connected]: 'connected',
  [ConnectionState.Reconnecting]: 'reconnecting',
  [ConnectionState.Disconnected]: 'disconnected',
  [ConnectionState.SignalReconnecting]: 'reconnecting',
}

/**
 * Live captions and tool activity: the call's two ledgers polled together and
 * interleaved on the call clock — chat bubbles for what was said, tool widgets
 * for what the agent is doing while it talks.
 */
function Captions({ sessionId, agentName }: { sessionId: string; agentName: string }) {
  const [turns, setTurns] = React.useState<TranscriptTurn[]>([])
  const [activity, setActivity] = React.useState<CallActivityEvent[]>([])
  const scrollRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const result = await getCallTranscriptAction(sessionId)
        if (!cancelled) {
          setTurns(result.turns)
          setActivity(result.activity)
        }
      } catch {
        // transient — next poll retries
      }
    }
    void poll()
    const interval = setInterval(poll, 2000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [sessionId])

  const feed = React.useMemo(() => {
    const items = toolActivityFromEvents(activity)
    const entries: ({ sort: number } & ({ type: 'turn'; turn: TranscriptTurn } | { type: 'tool'; item: ToolActivityItem }))[] = [
      ...turns.map((turn) => ({ type: 'turn' as const, sort: turn.atMs, turn })),
      ...items.map((item) => ({ type: 'tool' as const, sort: item.atMs, item })),
    ]
    entries.sort((a, b) => a.sort - b.sort)
    return entries
  }, [turns, activity])

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [feed.length])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Live transcript</CardTitle>
        <CardDescription>
          What is said and what {agentName} is doing, as it happens. It stays on the call record after you hang up.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div ref={scrollRef} className="max-h-[24rem] space-y-2 overflow-y-auto pr-1">
          {feed.length === 0 ? (
            <p className="text-sm text-fg-muted">Say hello — captions appear as the call is transcribed.</p>
          ) : (
            feed.map((entry) =>
              entry.type === 'tool' ? (
                <ToolActivityCard key={entry.item.key} item={entry.item} />
              ) : (
                <div
                  key={`turn-${entry.turn.seq}`}
                  className={`flex ${entry.turn.speaker === 'human' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                      entry.turn.speaker === 'human'
                        ? 'bg-primary-subtle text-fg'
                        : 'border border-border bg-bg-subtle text-fg'
                    }`}
                  >
                    <p className="mb-0.5 text-xs font-medium text-fg-muted">
                      {entry.turn.speaker === 'human' ? 'You' : agentName} ·{' '}
                      <span className="tabular-nums">
                        {Math.floor(entry.turn.atMs / 60000)}:
                        {String(Math.floor((entry.turn.atMs % 60000) / 1000)).padStart(2, '0')}
                      </span>
                    </p>
                    <p className="whitespace-pre-wrap">{entry.turn.text}</p>
                  </div>
                </div>
              ),
            )
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function CallControls({
  agent,
  avatar,
  onEnd,
  ending,
}: {
  agent: { name: string }
  avatar: { composition: AvatarComposition | null; parts: AvatarPart[]; categories: AvatarPartCategory[] }
  onEnd: () => void
  ending: boolean
}) {
  const connection = useConnectionState()
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant()
  const remotes = useRemoteParticipants()
  const agentJoined = remotes.length > 0
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          On the line
          <Badge variant={connection === ConnectionState.Connected ? 'default' : 'outline'}>
            {CONNECTION_LABELS[connection] ?? connection}
          </Badge>
        </CardTitle>
        <CardDescription>
          {connection !== ConnectionState.Connected
            ? 'Connecting you to the room…'
            : agentJoined
              ? `${agent.name} is on the call.`
              : `Ringing — waiting for ${agent.name} to pick up…`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {avatar.composition ? (
          <div className="flex justify-center">
            {/* The face on the call is the same composition the directory
                crops — zoomed to its head viewport, and animated while the
                agent is actually connected. */}
            <ComposedAvatar
              composition={avatar.composition}
              parts={avatar.parts}
              categories={avatar.categories}
              variant="head"
              size={180}
              rounded
              animate={connection === ConnectionState.Connected && agentJoined ? 'talking' : 'idle'}
              name={agent.name}
            />
          </div>
        ) : null}
        <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => void localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled)}
        >
          {isMicrophoneEnabled ? (
            <>
              <Mic className="mr-1.5 size-4" /> Mic on
            </>
          ) : (
            <>
              <MicOff className="mr-1.5 size-4" /> Mic off
            </>
          )}
        </Button>
        <Button type="button" variant="destructive" onClick={onEnd} disabled={ending}>
          <PhoneOff className="mr-1.5 size-4" /> {ending ? 'Hanging up…' : 'End call'}
        </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * The browser side of a call: a LiveKit room with the agent's voice agent as
 * the other participant. Audio only; captions poll the append-only ledger.
 */
export function CallRoom({
  serverUrl,
  token,
  sessionId,
  agent,
  avatar,
}: {
  serverUrl: string
  token: string
  sessionId: string
  agent: { id: string; name: string; title: string }
  avatar: { composition: AvatarComposition | null; parts: AvatarPart[]; categories: AvatarPartCategory[] }
}) {
  const router = useRouter()
  const [ending, setEnding] = React.useState(false)
  const endedRef = React.useRef(false)

  const finish = React.useCallback(async () => {
    if (endedRef.current) return
    endedRef.current = true
    setEnding(true)
    try {
      await endCallAction(sessionId)
    } finally {
      router.push(`/organization/agents?person=${agent.id}`)
    }
  }, [agent.id, router, sessionId])

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Calling ${agent.name}`}
        description={`${agent.title} · web call · everything said here lands on the call record and the run.`}
      />
      <LiveKitRoom
        serverUrl={serverUrl}
        token={token}
        audio
        video={false}
        connect
        onDisconnected={() => void finish()}
      >
        <RoomAudioRenderer />
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <CallControls agent={agent} avatar={avatar} onEnd={() => void finish()} ending={ending} />
          <Captions sessionId={sessionId} agentName={agent.name} />
        </div>
      </LiveKitRoom>
    </div>
  )
}
