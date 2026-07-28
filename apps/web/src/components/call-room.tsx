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
import { endCallAction, getCallTranscriptAction, type TranscriptTurn } from '../app/call/actions'

const CONNECTION_LABELS: Record<string, string> = {
  [ConnectionState.Connecting]: 'connecting',
  [ConnectionState.Connected]: 'connected',
  [ConnectionState.Reconnecting]: 'reconnecting',
  [ConnectionState.Disconnected]: 'disconnected',
  [ConnectionState.SignalReconnecting]: 'reconnecting',
}

/** Live captions: the call ledger polled from the browser, as chat bubbles. */
function Captions({ sessionId, handName }: { sessionId: string; handName: string }) {
  const [turns, setTurns] = React.useState<TranscriptTurn[]>([])
  const scrollRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const result = await getCallTranscriptAction(sessionId)
        if (!cancelled) setTurns(result.turns)
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
  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [turns.length])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Captions</CardTitle>
        <CardDescription>The transcript ledger, live. It stays on the call record after you hang up.</CardDescription>
      </CardHeader>
      <CardContent>
        <div ref={scrollRef} className="max-h-[24rem] space-y-2 overflow-y-auto pr-1">
          {turns.length === 0 ? (
            <p className="text-sm text-fg-muted">Say hello — captions appear as the call is transcribed.</p>
          ) : (
            turns.map((turn) => (
              <div key={turn.seq} className={`flex ${turn.speaker === 'human' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                    turn.speaker === 'human' ? 'bg-primary-subtle text-fg' : 'border border-border bg-bg-subtle text-fg'
                  }`}
                >
                  <p className="mb-0.5 text-xs font-medium text-fg-muted">
                    {turn.speaker === 'human' ? 'You' : handName} ·{' '}
                    <span className="tabular-nums">
                      {Math.floor(turn.atMs / 60000)}:{String(Math.floor((turn.atMs % 60000) / 1000)).padStart(2, '0')}
                    </span>
                  </p>
                  <p className="whitespace-pre-wrap">{turn.text}</p>
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function CallControls({
  hand,
  onEnd,
  ending,
}: {
  hand: { name: string }
  onEnd: () => void
  ending: boolean
}) {
  const connection = useConnectionState()
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant()
  const remotes = useRemoteParticipants()
  const handJoined = remotes.length > 0
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
            : handJoined
              ? `${hand.name} is on the call.`
              : `Waiting for ${hand.name} to pick up… (the voice agent worker answers — make sure it is running)`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-2">
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
      </CardContent>
    </Card>
  )
}

/**
 * The browser side of a call: a LiveKit room with the hand's voice agent as
 * the other participant. Audio only; captions poll the append-only ledger.
 */
export function CallRoom({
  serverUrl,
  token,
  sessionId,
  hand,
}: {
  serverUrl: string
  token: string
  sessionId: string
  hand: { id: string; name: string; title: string }
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
      router.push(`/people?person=${hand.id}`)
    }
  }, [hand.id, router, sessionId])

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Calling ${hand.name}`}
        description={`${hand.title} · web call · everything said here lands on the call record and the run.`}
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
          <CallControls hand={hand} onEnd={() => void finish()} ending={ending} />
          <Captions sessionId={sessionId} handName={hand.name} />
        </div>
      </LiveKitRoom>
    </div>
  )
}
