'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Phone } from 'lucide-react'
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useConnectionState,
  useLocalParticipant,
  useMediaDeviceSelect,
  useRemoteParticipants,
  useSpeakingParticipants,
} from '@livekit/components-react'
import { ConnectionState } from 'livekit-client'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
  cn,
  toast,
} from '@appkit/ui'
import { ComposedAvatar } from '@appkit/avatars/react'
import type { AvatarComposition, AvatarPart, AvatarPartCategory } from '@appkit/avatars/composition'
import type { ComposedAvatarAnimation } from '@appkit/avatars/react'
import {
  endCallAction,
  getCallTranscriptAction,
  startCallAction,
  type CallBrowserFrame,
  type TranscriptTurn,
} from '../app/call/actions'
import {
  describeBrowserStep,
  hostOf,
  toolActivityFromEvents,
  type CallActivityEvent,
  type ToolActivityItem,
} from '../lib/call-activity'
import { createCallTones, type CallTones } from '../lib/call-tones'
import { ToolActivityCard, ToolMark } from './tool-activity'
import {
  CALL_STAGE_AVATAR_SIZE,
  CallControlBar,
  CallStage,
  useCallTimer,
  type CallDeviceOption,
  type CallPhase,
  type CallStageActivity,
  type CallStageScreenView,
  type CallStatusTone,
} from './call-stage'

const CONNECTION_LABELS: Record<string, string> = {
  [ConnectionState.Connecting]: 'Connecting',
  [ConnectionState.Connected]: 'Connected',
  [ConnectionState.Reconnecting]: 'Reconnecting',
  [ConnectionState.Disconnected]: 'Disconnected',
  [ConnectionState.SignalReconnecting]: 'Reconnecting',
}

/**
 * Whether this browser can hand us a screen at all. Capability cannot change
 * inside a page's life, so the store never notifies; the server renders as
 * though it can — the overwhelmingly common case — and the first client render
 * corrects it, which keeps the control from flickering disabled on desktop.
 */
const NEVER_CHANGES = () => () => {}
const readScreenShareSupport = () =>
  typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function'
const SCREEN_SHARE_SUPPORTED_ON_SERVER = () => true

/**
 * The names a browser uses when the caller simply waved the picker away.
 * Dismissing that dialog rejects exactly as a denied permission does, and
 * neither deserves an error message — the control just stays off.
 */
const SCREEN_SHARE_DECLINED = new Set(['NotAllowedError', 'AbortError', 'PermissionDeniedError'])

function screenShareDeclined(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false
  return SCREEN_SHARE_DECLINED.has(String((error as { name: unknown }).name))
}

type AgentProfile = { id: string; name: string; title: string }
type AgentAvatar = { composition: AvatarComposition | null; parts: AvatarPart[]; categories: AvatarPartCategory[] }

/**
 * The face on the call: the same composition the directory crops, zoomed to
 * its head viewport at stage size. An agent with no composition yet still has
 * a face — the initials disc — so the stage never stands empty. Both forms are
 * rendered at the stage's own size; the stage scales them when it needs to.
 */
function AgentFace({ agent, avatar, animate }: { agent: AgentProfile; avatar: AgentAvatar; animate: ComposedAvatarAnimation }) {
  if (!avatar.composition) {
    return (
      <div
        role="img"
        aria-label={agent.name}
        style={{ width: CALL_STAGE_AVATAR_SIZE, height: CALL_STAGE_AVATAR_SIZE }}
        className="flex items-center justify-center rounded-full border border-border bg-primary-subtle text-primary"
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
      size={CALL_STAGE_AVATAR_SIZE}
      rounded
      animate={animate}
      name={agent.name}
    />
  )
}

/** Everything the call page polls for, on one loop. */
type CallFeed = { turns: TranscriptTurn[]; activity: CallActivityEvent[]; browser: CallBrowserFrame | null }

const EMPTY_FEED: CallFeed = { turns: [], activity: [], browser: null }

/**
 * The call's one poll: captions, tool activity, and the agent's screen arrive
 * together every two seconds and are shared by the stage and the transcript.
 * A failed poll is left alone — the next one two seconds later is the retry.
 */
function useCallFeed(sessionId: string): CallFeed {
  const [feed, setFeed] = React.useState<CallFeed>(EMPTY_FEED)
  React.useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const result = await getCallTranscriptAction(sessionId)
        if (!cancelled) setFeed({ turns: result.turns, activity: result.activity, browser: result.browser })
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
  return feed
}

/**
 * What the call sounds like before anyone speaks, driven by the phase alone: a
 * ringing tone for exactly as long as the agent is being rung, and one short
 * connect blip the moment they pick up — from the ringing phase or, when they
 * are quick enough that ringing never renders, straight from dialling.
 *
 * The player is built once for the life of the room and torn down with it, so
 * no oscillator, timer, or audio context outlives the call. A browser that
 * will not play it stays quiet and nothing else changes: every method on the
 * player absorbs its own failures.
 */
function useCallTones(phase: CallPhase): void {
  const tonesRef = React.useRef<CallTones | null>(null)
  const previousRef = React.useRef<CallPhase | null>(null)

  React.useEffect(() => {
    const tones = createCallTones()
    tonesRef.current = tones
    return () => {
      tonesRef.current = null
      tones.dispose()
    }
  }, [])

  // Declared after the player's own effect, which is what guarantees the
  // player exists by the time the first phase is read.
  React.useEffect(() => {
    const tones = tonesRef.current
    if (!tones) return
    const previous = previousRef.current
    previousRef.current = phase
    if (phase === 'ringing') {
      tones.startRinging()
      return
    }
    // Any other phase — live, ended, or a connection that fell back to
    // dialling — silences the ring first and asks questions after.
    tones.stopRinging()
    if (phase === 'live' && previous !== null && previous !== 'live') tones.connected()
  }, [phase])
}

/**
 * The newest browser frame as the stage wants it: a picture and its labels.
 * A frame from a visit that is over is still handed over — marked not live, so
 * the stage can retire it gracefully rather than have it disappear.
 */
function screenView(frame: CallBrowserFrame, live: boolean): CallStageScreenView {
  const host = hostOf(frame.detail.url)
  const title = frame.detail.title?.trim() || host || 'Working in the browser'
  return {
    live,
    imageUrl: frame.fileId ? `/api/files/${frame.fileId}` : null,
    title,
    host: host && host !== title ? host : null,
    action: describeBrowserStep(frame.action, frame.detail),
    atSeconds: Math.floor(frame.atMs / 1000),
    frameKey: String(frame.seq),
  }
}

/**
 * Live captions and tool activity: the call's two ledgers, interleaved on the
 * call clock — chat bubbles for what was said, tool widgets for what the agent
 * is doing while it talks. The whole history lives here; the stage carries only
 * the current moment. The feed follows the newest entry, but only while the
 * reader is at the live edge — scrolling up to reread holds the history still
 * until they return to the bottom.
 */
function CaptionsPanel({
  turns,
  items,
  agentName,
}: {
  turns: TranscriptTurn[]
  items: ToolActivityItem[]
  agentName: string
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const pinnedRef = React.useRef(true)

  const feed = React.useMemo(() => {
    const entries: ({ sort: number } & ({ type: 'turn'; turn: TranscriptTurn } | { type: 'tool'; item: ToolActivityItem }))[] = [
      ...turns.map((turn) => ({ type: 'turn' as const, sort: turn.atMs, turn })),
      ...items.map((item) => ({ type: 'tool' as const, sort: item.atMs, item })),
    ]
    entries.sort((a, b) => a.sort - b.sort)
    return entries
  }, [turns, items])

  React.useEffect(() => {
    if (pinnedRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [feed.length])

  return (
    // The card fills whatever height it is handed and the feed scrolls inside
    // it: beside the stage that is the stage's full height, so the two columns
    // end on the same line. Stacked on a narrow screen there is no height to
    // fill, and the capped reading height takes over instead.
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle className="text-base">Live transcript</CardTitle>
        <CardDescription>
          What is said and what {agentName} is doing, as it happens. It stays on the call record after you hang up.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const el = event.currentTarget
            pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
          }}
          className="min-h-[10rem] max-h-[24rem] space-y-2 overflow-y-auto pr-1 lg:max-h-none lg:flex-1"
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
 *
 * This is also where the caller's own media lives: the microphone and the
 * device it runs on, and the screen they choose to share. Each of those reads
 * its state back off the room rather than remembering what was asked for, so
 * the bar cannot drift from what is actually being sent.
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
  // isScreenShareEnabled is the room's own answer, recomputed from the
  // participant's published tracks — which is what keeps the share control
  // honest. Ending the share from the browser's own bar ends the media track;
  // livekit-client unpublishes it on that event, and this flag follows without
  // us watching for it.
  const { localParticipant, isMicrophoneEnabled, isScreenShareEnabled } = useLocalParticipant()
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
  useCallTones(phase)

  const statusLabel = closed ? 'Call ended' : ending ? 'Hanging up…' : (CONNECTION_LABELS[connection] ?? connection)
  const statusTone: CallStatusTone = closed
    ? 'off'
    : connection === ConnectionState.Connected
      ? 'ok'
      : connection === ConnectionState.Disconnected
        ? 'off'
        : 'pending'

  // The caller's own inputs. The room already holds microphone permission, so
  // the devices come back properly named without asking for anything again.
  const {
    devices: audioInputs,
    activeDeviceId: activeMicDeviceId,
    setActiveMediaDevice,
  } = useMediaDeviceSelect({ kind: 'audioinput' })
  const micDevices = React.useMemo<CallDeviceOption[]>(
    () =>
      audioInputs
        .filter((device) => device.deviceId !== '')
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label.trim() || `Microphone ${index + 1}`,
        })),
    [audioInputs],
  )
  const selectMicDevice = React.useCallback(
    (deviceId: string) => {
      void setActiveMediaDevice(deviceId).catch(() => {
        toast.error('That microphone could not be used', {
          description: 'The call is still on the microphone you were using.',
        })
      })
    },
    [setActiveMediaDevice],
  )

  // Sharing a screen is a round trip through the browser's own picker, so the
  // control is held busy until it settles — and the settled answer comes from
  // the room, never from an optimistic flag here. A caller who dismisses the
  // picker lands back exactly where they started, silently.
  const screenShareSupported = React.useSyncExternalStore(
    NEVER_CHANGES,
    readScreenShareSupport,
    SCREEN_SHARE_SUPPORTED_ON_SERVER,
  )
  const [sharePending, setSharePending] = React.useState(false)
  const toggleScreenShare = React.useCallback(() => {
    const next = !isScreenShareEnabled
    setSharePending(true)
    localParticipant
      .setScreenShareEnabled(next)
      .catch((error: unknown) => {
        if (screenShareDeclined(error)) return
        toast.error(next ? 'Your screen could not be shared' : 'Your screen is still being shared', {
          description: next
            ? 'Check that this browser is allowed to record your screen, then try again.'
            : 'Stop it from your browser’s sharing bar if it keeps going.',
        })
      })
      .finally(() => setSharePending(false))
  }, [isScreenShareEnabled, localParticipant])
  // Starting a share has preconditions; stopping one never does — whatever the
  // call is doing, a caller who is sending their screen can always take it back.
  const shareUnavailableReason = isScreenShareEnabled
    ? null
    : !screenShareSupported
      ? 'Screen sharing is not available in this browser'
      : phase === 'ended'
        ? 'The call has ended'
        : phase !== 'live'
          ? `Screen sharing becomes available once ${agent.name} picks up`
          : null

  const [transcriptVisible, setTranscriptVisible] = React.useState(true)

  const { turns, activity, browser } = useCallFeed(sessionId)
  const items = React.useMemo(() => toolActivityFromEvents(activity), [activity])

  // The stage carries the present tense: the newest action still in flight —
  // running, or parked for a signature — and the screen behind it while the
  // agent is at the keyboard. Once the call has ended, the face has the stage
  // back for the goodbye; the whole story stays in the transcript beside it.
  const current = React.useMemo(() => {
    if (phase === 'ended') return null
    const item = [...items].reverse().find((i) => i.status === 'running' || i.status === 'queued')
    if (!item) return null
    const stageActivity: CallStageActivity = {
      key: item.key,
      label: item.label,
      status: item.status === 'queued' ? 'queued' : 'running',
      icon: <ToolMark toolName={item.toolName} className="size-3.5" />,
    }
    return stageActivity
  }, [items, phase])
  const screen = React.useMemo(
    () => (browser ? screenView(browser, browser.live && phase !== 'ended') : null),
    [browser, phase],
  )

  return (
    <div
      className={cn('grid gap-4', transcriptVisible && 'lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]')}
    >
      <Card>
        <CardContent className="flex flex-col items-center gap-8 px-6 py-10">
          <CallStage
            name={agent.name}
            title={agent.title}
            phase={phase}
            speaking={agentSpeaking}
            elapsedSeconds={elapsedSeconds}
            screen={screen}
            activity={current}
            avatar={<AgentFace agent={agent} avatar={avatar} animate={agentSpeaking ? 'talking' : phase === 'ended' ? 'none' : 'idle'} />}
          />
          <CallControlBar
            micEnabled={isMicrophoneEnabled}
            onToggleMic={() => void localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled)}
            micDevices={micDevices}
            activeMicDeviceId={activeMicDeviceId}
            onSelectMicDevice={selectMicDevice}
            sharingScreen={isScreenShareEnabled}
            sharePending={sharePending}
            onToggleScreenShare={toggleScreenShare}
            shareUnavailableReason={shareUnavailableReason}
            transcriptVisible={transcriptVisible}
            onToggleTranscript={() => setTranscriptVisible((visible) => !visible)}
            onEnd={onEnd}
            ending={ending}
            statusLabel={statusLabel}
            statusTone={statusTone}
          />
        </CardContent>
      </Card>
      {transcriptVisible ? (
        // Beside the stage the transcript is taken out of flow, so it can never
        // be the thing that decides how tall the row is — the stage decides,
        // always — and then it fills exactly the height it was given. That is
        // what lines the two bottom edges up without the page growing a
        // scrollbar, and what keeps the stage perfectly still when the caller
        // dismisses the transcript. Stacked below lg it is an ordinary card.
        <div className="lg:relative">
          <div className="lg:absolute lg:inset-0">
            <CaptionsPanel turns={turns} items={items} agentName={agent.name} />
          </div>
        </div>
      ) : null}
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
      router.push(`/organization?person=${agent.id}`)
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
