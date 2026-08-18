'use client'

import * as React from 'react'
import { ArrowDown, Phone } from 'lucide-react'
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useConnectionState,
  useLocalParticipant,
  useMediaDeviceSelect,
  useRemoteParticipants,
  useSpeakingParticipants,
} from '@livekit/components-react'
import { ConnectionState, ParticipantKind, type RoomOptions } from 'livekit-client'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  toast,
} from '@braedonsaunders/appkit-ui'
import { ComposedAvatar } from '@braedonsaunders/appkit-avatars/react'
import { useElementSize } from '@braedonsaunders/appkit-scene'
import type { AvatarComposition, AvatarPart, AvatarPartCategory } from '@braedonsaunders/appkit-avatars/composition'
import type { ComposedAvatarAnimation } from '@braedonsaunders/appkit-avatars/react'
import {
  endCallAction,
  getCallTranscriptAction,
  startCallAction,
  type TranscriptTurn,
} from '../app/call/actions'
import {
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
  type CallStatusTone,
} from './call-stage'

/**
 * How long the resolved stage is held before the caller is taken back to the
 * agent's profile. Long enough for the hang-up tone to finish and the face to
 * settle out — a third of a second each, running together — and then to read
 * "Call ended" with the duration beside it; short enough that nobody is left
 * sitting on a call that is over. The bookkeeping runs underneath it and is
 * never allowed to lengthen it.
 */
const ENDED_HOLD_MS = 1100

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

export type AgentProfile = { id: string; name: string; title: string }
export type AgentAvatar = { composition: AvatarComposition | null; parts: AvatarPart[]; categories: AvatarPartCategory[] }

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

/** Captions and activity for the center pane; visual work lives in the shared rail. */
type CallFeed = { turns: TranscriptTurn[]; activity: CallActivityEvent[] }

const EMPTY_FEED: CallFeed = { turns: [], activity: [] }

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
        if (!cancelled) setFeed({ turns: result.turns, activity: result.activity })
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
 * What the call sounds like around the talking: a ringing tone for exactly as
 * long as the agent is being rung, one short connect blip the moment they pick
 * up — from the ringing phase or, when they are quick enough that ringing never
 * renders, straight from dialling — a keyboard for as long as the agent is away
 * doing something, and the receiver going down the instant the call ends,
 * however it ended. The phase drives all of it but the typing, which follows
 * the work itself so it can never be heard over an agent who has finished. The
 * caller hanging up, the agent hanging up, and the line dropping all arrive
 * here as the same phase change, and all three sound the same, because to the
 * person on the call they are the same thing: the call is over.
 *
 * The player is built once for the life of the room and torn down with it, so
 * no oscillator, timer, or audio context outlives the call. A browser that
 * will not play it stays quiet and nothing else changes: every method on the
 * player absorbs its own failures.
 */
function useCallTones(phase: CallPhase, working: boolean): void {
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
    // dialling — silences the ring first and asks questions after. The first
    // phase a call is ever in is sounded by nothing: there is no arrival to
    // mark until there is something to have arrived from.
    tones.stopRinging()
    if (previous === null || previous === phase) return
    if (phase === 'live') tones.connected()
    else if (phase === 'ended') tones.hangup()
  }, [phase])

  // The keyboard, for as long as there is genuinely something in flight. A
  // caller who hears nothing at all assumes the line has dropped; a caller who
  // hears someone typing knows they are being dealt with, and waits. It stops
  // the moment the work does, so it never outlives what it is reporting.
  React.useEffect(() => {
    const tones = tonesRef.current
    if (!tones) return
    if (working && phase === 'live') tones.startTyping()
    else tones.stopTyping()
  }, [working, phase])
}

/**
 * How close to the bottom of the feed still counts as reading the live edge.
 * Wide enough to survive a rounded scroll position and the last entry's own
 * entrance, narrow enough that a reader who has deliberately scrolled up by a
 * line is left where they put themselves.
 */
const LIVE_EDGE_PX = 32

/**
 * Live captions and tool activity: the call's two ledgers, interleaved on the
 * call clock — chat bubbles for what was said, tool widgets for what the agent
 * is doing while it talks. The whole history lives here; the stage carries only
 * the current moment.
 *
 * The feed follows the newest entry, but only while the reader is at the live
 * edge — scrolling up to reread holds the history still, and says so with the
 * one control that takes them back. Following resumes on its own the moment
 * they scroll back down to the bottom.
 *
 * What it follows is the measured height of the feed, not a count of entries:
 * an entry that is already on screen grows after it arrives — a tool call
 * gaining its detail line, a status resolving, a long turn rewrapping when the
 * panel is resized — and every one of those moves the newest line out of sight
 * without adding anything to count. The viewport is measured for the same
 * reason: a window resized shorter must not leave the reader stranded above
 * the live edge.
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
  const [viewportRef, viewport] = useElementSize<HTMLDivElement>()
  const [contentRef, content] = useElementSize<HTMLDivElement>()
  const [following, setFollowing] = React.useState(true)

  const feed = React.useMemo(() => {
    const entries: ({ sort: number } & ({ type: 'turn'; turn: TranscriptTurn } | { type: 'tool'; item: ToolActivityItem }))[] = [
      ...turns.map((turn) => ({ type: 'turn' as const, sort: turn.atMs, turn })),
      ...items.map((item) => ({ type: 'tool' as const, sort: item.atMs, item })),
    ]
    entries.sort((a, b) => a.sort - b.sort)
    return entries
  }, [turns, items])

  // Before the browser paints, so the newest line is never shown arriving off
  // the bottom of the panel. `scrollTop` past the end is clamped by the
  // browser, which is exactly the "as far down as this goes" we want.
  React.useLayoutEffect(() => {
    if (!following) return
    const el = viewportRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [following, feed.length, content.height, viewport.height, viewportRef])

  return (
    // The card fills whatever height it is handed and the feed scrolls inside
    // it: beside the stage that is the row's full height, so the two columns
    // end on the same line. Stacked on a narrow screen there is no height to
    // fill, and the capped reading height takes over instead.
    <Card className="flex h-full min-h-0 flex-col">
      <CardHeader className="shrink-0">
        <CardTitle className="text-base">Live transcript</CardTitle>
        <CardDescription>
          What is said and what {agentName} is doing, as it happens. It stays on the call record after you hang up.
        </CardDescription>
      </CardHeader>
      <CardContent className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={viewportRef}
          onScroll={(event) => {
            const el = event.currentTarget
            setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight <= LIVE_EDGE_PX)
          }}
          className="app-scroll min-h-[10rem] max-h-[24rem] overflow-y-auto pr-1 lg:max-h-none lg:min-h-0 lg:flex-1"
        >
          <div ref={contentRef} className="space-y-2">
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
        </div>
        {/* The way back, and only while there is a way back to offer. Pressing
            it hands the feed to the effect above rather than scrolling here:
            following is the state, and the scrolling is what following does. */}
        {following ? null : (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="bh-call-enter pointer-events-auto rounded-full border border-border shadow-md"
              onClick={() => setFollowing(true)}
            >
              <ArrowDown aria-hidden className="size-3.5" />
              Jump to latest
            </Button>
          </div>
        )}
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
  onEnd,
}: {
  agent: AgentProfile
  avatar: AgentAvatar
  sessionId: string
  /** True from the moment the call is over, whoever ended it. */
  closed: boolean
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
  // that does not exist until the agent picks up. Match LiveKit's agent kind
  // explicitly: a subscribe-only chat observer may share this room, and must
  // never make the caller believe the agent answered or started speaking.
  const speakers = useSpeakingParticipants()
  const agentJoined = remotes.some((participant) => participant.kind === ParticipantKind.AGENT)
  const agentSpeaking = agentJoined && speakers.some((participant) => participant.kind === ParticipantKind.AGENT)

  const phase: CallPhase = closed
    ? 'ended'
    : agentJoined
      ? 'live'
      : connection === ConnectionState.Connected
        ? 'ringing'
        : 'dialling'
  const elapsedSeconds = useCallTimer(phase === 'live')

  // There is no "hanging up" to report: a hang-up is instant here, and the
  // room is dropped in the same beat. The line either carries a call or says
  // the call is over.
  const statusLabel = closed ? 'Call ended' : (CONNECTION_LABELS[connection] ?? connection)
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

  const [transcriptVisible, setTranscriptVisible] = React.useState(false)
  const { turns, activity } = useCallFeed(sessionId)
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

  // Sounded from the stage's own reading of what is happening, so the keyboard
  // and the thing it is reporting can never disagree. Only 'running' counts:
  // an action parked for a signature is the agent waiting on a person, and
  // nobody types while they wait.
  useCallTones(phase, current?.status === 'running')
  return (
    <div className="flex size-full min-h-0 flex-col bg-bg-subtle p-4">
      <div className="flex min-h-0 flex-1 flex-col items-center gap-4 rounded-xl border border-border bg-surface px-4 py-5 shadow-sm">
          <CallStage
            name={agent.name}
            title={agent.title}
            phase={phase}
            speaking={agentSpeaking}
            elapsedSeconds={elapsedSeconds}
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
            ended={phase === 'ended'}
            statusLabel={statusLabel}
            statusTone={statusTone}
          />
      </div>
      {transcriptVisible ? (
        <div className="mt-3 h-44 min-h-0 shrink-0 overflow-hidden rounded-xl border border-border bg-surface">
          <CaptionsPanel turns={turns} items={items} agentName={agent.name} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * The microphone's own defences, spelled out rather than left to defaults.
 * On one call the agent's voice went out the caller's speakers, back in
 * their microphone, and came back transcribed as the caller — the agent was
 * barged in on by its own echo and cut off mid-sentence twice. The browser's
 * echo canceller is the first and best defence against that loop; asking for
 * it explicitly (with noise suppression and gain control beside it) means a
 * browser that CAN cancel echo always does, instead of whatever the library
 * default happens to be that release.
 *
 * Module-level on purpose: LiveKitRoom treats a new options object as a new
 * room, and an inline literal is a new object every render.
 */
const ROOM_OPTIONS: RoomOptions = {
  audioCaptureDefaults: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
}

/**
 * A web call occupying the conversation pane. It creates the call run inside
 * the supplied chat thread, while the sibling work rail continues to display
 * Desktop, Browser, Terminal, Files, and History.
 */
export function ConversationCall({
  serverUrl,
  agent,
  avatar,
  threadId,
  onEnded,
}: {
  serverUrl: string
  agent: AgentProfile
  avatar: AgentAvatar
  threadId: string
  onEnded: () => void
}) {
  const [call, setCall] = React.useState<{ sessionId: string; token: string } | null>(null)
  const [placeError, setPlaceError] = React.useState<string | null>(null)
  const [closed, setClosed] = React.useState(false)
  const placedRef = React.useRef(false)
  const endedRef = React.useRef(false)
  const releaseRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => () => {
    if (releaseRef.current) clearTimeout(releaseRef.current)
  }, [])

  const place = React.useCallback(() => {
    if (placedRef.current) return
    placedRef.current = true
    setPlaceError(null)
    startCallAction(agent.id, threadId).then(
      setCall,
      (error: unknown) => {
        placedRef.current = false
        setPlaceError(error instanceof Error ? error.message : 'The call could not be started.')
      },
    )
  }, [agent.id, threadId])

  React.useEffect(place, [place])

  const finish = React.useCallback(() => {
    if (endedRef.current || !call) return
    endedRef.current = true
    setClosed(true)
    void endCallAction(call.sessionId).catch(() => undefined)
    releaseRef.current = setTimeout(() => {
      releaseRef.current = null
      onEnded()
    }, ENDED_HOLD_MS)
  }, [call, onEnded])

  if (!call) {
    return (
      <div className="flex size-full min-h-0 flex-col items-center justify-center gap-5 bg-bg-subtle p-5">
        <CallStage
          name={agent.name}
          title={agent.title}
          phase="dialling"
          speaking={false}
          elapsedSeconds={0}
          status={placeError ? 'The call did not go through' : `Connecting your microphone and ringing ${agent.name}.`}
          avatar={<AgentFace agent={agent} avatar={avatar} animate="idle" />}
        />
        {placeError ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="max-w-sm text-sm text-fg-muted">{placeError}</p>
            <Button type="button" onClick={place}><Phone aria-hidden className="size-4" /> Try again</Button>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <LiveKitRoom
      className="flex size-full min-h-0 flex-col"
      serverUrl={serverUrl}
      token={call.token}
      audio
      video={false}
      options={ROOM_OPTIONS}
      connect={!closed}
      onDisconnected={finish}
    >
      <RoomAudioRenderer />
      <LiveCallSurface
        agent={agent}
        avatar={avatar}
        sessionId={call.sessionId}
        closed={closed}
        onEnd={finish}
      />
    </LiveKitRoom>
  )
}
