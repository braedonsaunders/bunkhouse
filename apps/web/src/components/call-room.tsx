'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Phone } from 'lucide-react'
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useConnectionState,
  useLocalParticipant,
  useRemoteParticipants,
  useSpeakingParticipants,
} from '@livekit/components-react'
import { ConnectionState } from 'livekit-client'
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader } from '@appkit/ui'
import { ComposedAvatar } from '@appkit/avatars/react'
import type { AvatarComposition, AvatarPart, AvatarPartCategory } from '@appkit/avatars/composition'
import type { ComposedAvatarAnimation } from '@appkit/avatars/react'
import { endCallAction, getCallTranscriptAction, startCallAction, type TranscriptTurn } from '../app/call/actions'
import { toolActivityFromEvents, type CallActivityEvent, type ToolActivityItem } from '../lib/call-activity'
import { ToolActivityCard } from './tool-activity'
import { CallControlBar, CallStage, useCallTimer, type CallPhase, type CallStatusTone } from './call-stage'

const CONNECTION_LABELS: Record<string, string> = {
  [ConnectionState.Connecting]: 'Connecting',
  [ConnectionState.Connected]: 'Connected',
  [ConnectionState.Reconnecting]: 'Reconnecting',
  [ConnectionState.Disconnected]: 'Disconnected',
  [ConnectionState.SignalReconnecting]: 'Reconnecting',
}

type AgentProfile = { id: string; name: string; title: string }
type AgentAvatar = { composition: AvatarComposition | null; parts: AvatarPart[]; categories: AvatarPartCategory[] }

/** The stage avatar's rendered size — the call's centerpiece, not a thumbnail. */
const STAGE_AVATAR_SIZE = 320

/**
 * The face on the call: the same composition the directory crops, zoomed to
 * its head viewport at stage size. An agent with no composition yet still has
 * a face — the initials disc — so the stage never stands empty.
 */
function AgentFace({ agent, avatar, animate }: { agent: AgentProfile; avatar: AgentAvatar; animate: ComposedAvatarAnimation }) {
  if (!avatar.composition) {
    return (
      <div
        role="img"
        aria-label={agent.name}
        className="flex size-80 items-center justify-center rounded-full border border-border bg-primary-subtle text-primary"
      >
        <span className="text-8xl font-semibold">{agent.name.charAt(0).toUpperCase()}</span>
      </div>
    )
  }
  return (
    <ComposedAvatar
      composition={avatar.composition}
      parts={avatar.parts}
      categories={avatar.categories}
      variant="head"
      size={STAGE_AVATAR_SIZE}
      rounded
      animate={animate}
      name={agent.name}
    />
  )
}

/**
 * Live captions and tool activity: the call's two ledgers polled together and
 * interleaved on the call clock — chat bubbles for what was said, tool widgets
 * for what the agent is doing while it talks. The feed follows the newest
 * entry, but only while the reader is at the live edge — scrolling up to
 * reread holds the history still until they return to the bottom.
 */
function CaptionsPanel({ sessionId, agentName }: { sessionId: string; agentName: string }) {
  const [turns, setTurns] = React.useState<TranscriptTurn[]>([])
  const [activity, setActivity] = React.useState<CallActivityEvent[]>([])
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const pinnedRef = React.useRef(true)
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
    if (pinnedRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
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
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const el = event.currentTarget
            pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
          }}
          className="max-h-[24rem] min-h-[10rem] space-y-2 overflow-y-auto pr-1 lg:max-h-[32rem]"
        >
          {feed.length === 0 ? (
            <p className="text-sm text-fg-muted">Say hello — captions appear as the call is transcribed.</p>
          ) : (
            feed.map((entry) =>
              entry.type === 'tool' ? (
                <div key={entry.item.key} className="bh-call-enter">
                  <ToolActivityCard item={entry.item} />
                </div>
              ) : (
                <div
                  key={`turn-${entry.turn.seq}`}
                  className={`bh-call-enter flex ${entry.turn.speaker === 'human' ? 'justify-end' : 'justify-start'}`}
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

/**
 * Everything inside the room: phase, timer, speaking state, and the stage +
 * control bar they drive. Phases in order — dialling (connection coming up),
 * ringing (in the room, agent not yet joined), live (agent on the line),
 * ended (the room closed). The room closing is how every call ends — the
 * caller hanging up, the agent hanging up (it deletes the room), or the
 * connection being lost — so `closed` lands on the ended phase, never on an
 * error state.
 */
function LiveCallSurface({
  agent,
  avatar,
  sessionId,
  closed,
  ending,
  onEnd,
}: {
  agent: AgentProfile
  avatar: AgentAvatar
  sessionId: string
  closed: boolean
  ending: boolean
  onEnd: () => void
}) {
  const connection = useConnectionState()
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant()
  const remotes = useRemoteParticipants()
  // The library's speaking state, not mere presence: useSpeakingParticipants
  // is the unconditional-hook form of useIsSpeaking, which needs a participant
  // that does not exist until the agent picks up. Any non-local speaker is the
  // agent's voice — the caller is the only other participant on a web call.
  const speakers = useSpeakingParticipants()
  const agentJoined = remotes.length > 0
  const agentSpeaking = agentJoined && speakers.some((participant) => !participant.isLocal)

  const phase: CallPhase = closed
    ? 'ended'
    : agentJoined
      ? 'live'
      : connection === ConnectionState.Connected
        ? 'ringing'
        : 'dialling'
  const elapsedSeconds = useCallTimer(phase === 'live')

  const statusLabel = closed ? 'Call ended' : ending ? 'Hanging up…' : (CONNECTION_LABELS[connection] ?? connection)
  const statusTone: CallStatusTone = closed
    ? 'off'
    : connection === ConnectionState.Connected
      ? 'ok'
      : connection === ConnectionState.Disconnected
        ? 'off'
        : 'pending'

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Card>
        <CardContent className="flex flex-col items-center gap-8 px-6 py-10">
          <CallStage
            name={agent.name}
            title={agent.title}
            phase={phase}
            speaking={agentSpeaking}
            elapsedSeconds={elapsedSeconds}
            avatar={<AgentFace agent={agent} avatar={avatar} animate={agentSpeaking ? 'talking' : phase === 'ended' ? 'none' : 'idle'} />}
          />
          <CallControlBar
            micEnabled={isMicrophoneEnabled}
            onToggleMic={() => void localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled)}
            onEnd={onEnd}
            ending={ending}
            statusLabel={statusLabel}
            statusTone={statusTone}
          />
        </CardContent>
      </Card>
      <CaptionsPanel sessionId={sessionId} agentName={agent.name} />
    </div>
  )
}

/**
 * The browser side of a call: a LiveKit room with the agent's voice agent as
 * the other participant. Audio only; captions poll the append-only ledger.
 * Opening the page IS placing the call — the session, its run, and the token
 * come from startCallAction the moment the page mounts, so there is no lobby
 * to click through. The ref guard keeps a remounted effect (React strict mode)
 * from opening a second session and run for the same call.
 */
export function CallRoom({
  serverUrl,
  agent,
  avatar,
}: {
  serverUrl: string
  agent: AgentProfile
  avatar: AgentAvatar
}) {
  const router = useRouter()
  const [call, setCall] = React.useState<{ sessionId: string; token: string } | null>(null)
  const [placeError, setPlaceError] = React.useState<string | null>(null)
  const [ending, setEnding] = React.useState(false)
  const [closed, setClosed] = React.useState(false)
  const endedRef = React.useRef(false)
  const placedRef = React.useRef(false)

  // Every state change lands in a promise callback rather than in the body:
  // this runs straight out of an effect on mount, and a setState reached
  // synchronously from there costs a cascading render. A previous error
  // clears when the retry actually succeeds, so the message stays put while
  // the retry is in flight instead of blinking out and back.
  const place = React.useCallback(() => {
    if (placedRef.current) return
    placedRef.current = true
    startCallAction(agent.id).then(
      (started) => {
        setCall(started)
        setPlaceError(null)
      },
      (error: unknown) => {
        placedRef.current = false
        setPlaceError(error instanceof Error ? error.message : 'The call could not be started.')
      },
    )
  }, [agent.id])

  React.useEffect(place, [place])

  const finish = React.useCallback(async () => {
    if (endedRef.current || !call) return
    endedRef.current = true
    setEnding(true)
    try {
      await endCallAction(call.sessionId)
    } finally {
      router.push(`/organization/agents?person=${agent.id}`)
    }
  }, [agent.id, call, router])

  // The room disconnecting is a normal end of call — the agent hangs up by
  // deleting the room, which arrives here exactly like our own hang-up. Land
  // on the ended phase first so the stage reads "Call ended" while the
  // session is finalized and the caller is taken back to the profile.
  const handleDisconnected = React.useCallback(() => {
    setClosed(true)
    void finish()
  }, [finish])

  const header = (
    <PageHeader
      title={`Calling ${agent.name}`}
      description={`${agent.title} · web call · everything said here lands on the call record and the run.`}
    />
  )

  if (!call) {
    return (
      <div className="space-y-6">
        {header}
        <Card>
          <CardContent className="flex flex-col items-center gap-8 px-6 py-10">
            <CallStage
              name={agent.name}
              title={agent.title}
              phase="dialling"
              speaking={false}
              elapsedSeconds={0}
              status={
                placeError ? (
                  <span className="font-medium text-fg">The call did not go through</span>
                ) : (
                  `Connecting your microphone and ringing ${agent.name}.`
                )
              }
              avatar={<AgentFace agent={agent} avatar={avatar} animate="idle" />}
            />
            {placeError ? (
              <div className="bh-call-enter flex flex-col items-center gap-3 text-center">
                <p className="max-w-md text-sm text-fg-muted">{placeError}</p>
                <Button type="button" onClick={place}>
                  <Phone className="mr-1.5 size-4" /> Try again
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {header}
      <LiveKitRoom
        serverUrl={serverUrl}
        token={call.token}
        audio
        video={false}
        connect
        onDisconnected={handleDisconnected}
      >
        <RoomAudioRenderer />
        <LiveCallSurface
          agent={agent}
          avatar={avatar}
          sessionId={call.sessionId}
          closed={closed}
          ending={ending}
          onEnd={() => void finish()}
        />
      </LiveKitRoom>
    </div>
  )
}
