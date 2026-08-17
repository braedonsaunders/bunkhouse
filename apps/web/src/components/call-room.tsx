'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ArrowDown, Phone } from 'lucide-react'
import {
  LiveKitRoom,
  RoomAudioRenderer,
  VideoTrack,
  useConnectionState,
  useLocalParticipant,
  useMediaDeviceSelect,
  useRemoteParticipants,
  useSpeakingParticipants,
  useTracks,
} from '@livekit/components-react'
import { ConnectionState, Track, type RoomOptions } from 'livekit-client'
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
} from '@braedonsaunders/appkit-ui'
import { ComposedAvatar } from '@braedonsaunders/appkit-avatars/react'
import { useElementSize } from '@braedonsaunders/appkit-scene'
import type { AvatarComposition, AvatarPart, AvatarPartCategory } from '@braedonsaunders/appkit-avatars/composition'
import type { ComposedAvatarAnimation } from '@braedonsaunders/appkit-avatars/react'
import {
  endCallAction,
  getCallTranscriptAction,
  startCallAction,
  type CallBrowserFrame,
  type TranscriptTurn,
} from '../app/call/actions'
import {
  describeDeskEvent,
  hostOf,
  toolActivityFromEvents,
  type CallActivityEvent,
  type ToolActivityItem,
} from '../lib/call-activity'
import { createCallTones, type CallTones } from '../lib/call-tones'
import { AGENT_SCREEN_TRACK_NAME } from '../lib/agent-screen'
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
 * The newest desk frame as the stage wants it: a picture and its labels.
 * A frame from a session that is over is still handed over — marked not live,
 * so the stage can retire it gracefully rather than have it disappear.
 *
 * This is the still path, and it is not going anywhere: the screenshot ledger
 * is the audit record, it is what the run record replays, and it is what is
 * left on the stage after the desk work ends and its track goes away. While
 * the desk is on screen during a call there is live video of the same picture,
 * and that takes the stage; everything else here — which page, what was just
 * done — still comes from the ledger.
 */
function screenView(frame: CallBrowserFrame, live: boolean): CallStageScreenView {
  const host = hostOf(frame.detail.url)
  const title = frame.detail.title?.trim() || host || 'Working at the desk'
  return {
    live,
    imageUrl: frame.fileId ? `/api/files/${frame.fileId}` : null,
    title,
    host: host && host !== title ? host : null,
    action: describeDeskEvent(frame.action, frame.detail),
    atSeconds: Math.floor(frame.atMs / 1000),
    frameKey: String(frame.seq),
  }
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

  const [transcriptVisible, setTranscriptVisible] = React.useState(true)

  // The agent's own desk, live in this room — its browser today, its desktop
  // screen when one is open. It publishes itself as an ordinary screen-share
  // track while it has something on screen, so watching it needs no polling
  // and no second transport — the room is already here.
  //
  // Source alone would not identify it: in a meeting a human guest shares a
  // screen from another remote participant on the very same source. The track
  // name is what says this one is the agent's, and the local filter keeps the
  // caller's own share off the caller's own stage.
  const screenTracks = useTracks([Track.Source.ScreenShare], { onlySubscribed: true })
  const agentScreen = React.useMemo(
    () =>
      screenTracks.find(
        (track) => !track.participant.isLocal && track.publication.trackName === AGENT_SCREEN_TRACK_NAME,
      ) ?? null,
    [screenTracks],
  )

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

  // Sounded from the stage's own reading of what is happening, so the keyboard
  // and the thing it is reporting can never disagree. Only 'running' counts:
  // an action parked for a signature is the agent waiting on a person, and
  // nobody types while they wait.
  useCallTones(phase, current?.status === 'running')
  const screen = React.useMemo<CallStageScreenView | null>(() => {
    const still = browser ? screenView(browser, browser.live && phase !== 'ended') : null
    if (!agentScreen || phase === 'ended') return still
    // The track is the present tense in a way the ledger cannot be: it exists
    // for exactly as long as the agent's desk has something on screen, and it
    // carries the picture as it moves rather than as it was two seconds ago.
    // The ledger still supplies the words around it — which page, and what was
    // just done on it.
    const video = <VideoTrack trackRef={agentScreen} />
    return still
      ? { ...still, live: true, video }
      : {
          // The screen has opened but no step has landed on the record yet.
          live: true,
          video,
          imageUrl: null,
          title: 'Working at the desk',
          host: null,
          action: 'Opening the page',
          atSeconds: elapsedSeconds,
          frameKey: 'live',
        }
  }, [agentScreen, browser, elapsedSeconds, phase])

  return (
    // One row, as tall as whatever the screen has left. The row is explicitly
    // allowed to be shorter than its contents' natural height (`minmax(0,1fr)`
    // rather than the automatic track, whose floor is its content) — that is
    // what lets the stage inside it give way instead of pushing the control
    // bar off the bottom of the page. Below `lg` the two columns stack and the
    // screen scrolls, so the row is left to size itself.
    <div
      className={cn(
        'grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-rows-[minmax(0,1fr)]',
        transcriptVisible && 'lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]',
      )}
    >
      <Card className="flex min-h-0 flex-col">
        <CardContent className="flex min-h-0 flex-1 flex-col items-center gap-6 px-6 py-6">
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
            ended={phase === 'ended'}
            statusLabel={statusLabel}
            statusTone={statusTone}
          />
        </CardContent>
      </Card>
      {/* Beside the stage the transcript is simply the row's other column, and
          the row's height is the screen's, not the stage's — so neither column
          can make the page taller, the two bottom edges line up, and the stage
          does not move when the caller dismisses the transcript. Stacked below
          lg it is an ordinary card with its own reading height. */}
      {transcriptVisible ? <CaptionsPanel turns={turns} items={items} agentName={agent.name} /> : null}
    </div>
  )
}

/**
 * The call's one screen: the page header, then whatever is on the line. From
 * `lg` up it is exactly as tall as the shell's canvas and no taller — a call is
 * a fixed screen, and a caller must never have to scroll to find the button
 * that ends it. Below `lg` the columns stack, the screen takes its natural
 * height, and the canvas scrolls: a phone cannot hold all of this at once.
 */
function CallScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-(--breakpoint-2xl) flex-col gap-4 p-4 sm:p-6 lg:h-full">
      {children}
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
 * The browser side of a call: a LiveKit room with the agent's voice agent as
 * the other participant. Audio only; captions poll the append-only ledger.
 * Opening the page IS placing the call — the session, its run, and the token
 * come from startCallAction the moment the page mounts, so there is no lobby
 * to click through. The ref guard keeps a remounted effect (React strict mode)
 * from opening a second session and run for the same call.
 *
 * Ending is the mirror of that: instant, local, and exactly once, with the
 * server-side bookkeeping and the trip back to the profile both happening
 * after the caller has already seen and heard the call end.
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
  const [closed, setClosed] = React.useState(false)
  const endedRef = React.useRef(false)
  const placedRef = React.useRef(false)
  const leaveRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // The one timer this component owns. It is cleared on the way out so a page
  // the caller left themselves can never navigate out from under them later.
  React.useEffect(
    () => () => {
      if (leaveRef.current !== null) clearTimeout(leaveRef.current)
    },
    [],
  )

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

  /**
   * End the call, once. Everything the caller can see or hear happens in this
   * turn: the stage lands on `ended`, the hang-up tone sounds, the face settles
   * out, and the room is dropped on the very next render — a call is over the
   * moment it is over, so nothing here waits on the network. Closing the
   * session record is bookkeeping and runs alongside; the caller is taken back
   * to the profile after a beat, whether or not that write has landed.
   *
   * The ref is the exactly-once guard, and it is set before anything else: our
   * own hang-up drops the room, the room's disconnect comes back through here,
   * and it finds the door already shut. The agent hanging up arrives the same
   * way from the other direction, and only one of the two can ever be first.
   */
  const finish = React.useCallback(() => {
    if (endedRef.current || !call) return
    endedRef.current = true
    setClosed(true)
    // A failed write is not something a caller on a finished call can act on,
    // and it must never hold up their ending — the run and the call ledger
    // both keep their own record of what happened either way.
    void endCallAction(call.sessionId).catch(() => {})
    const profile = `/organization?person=${agent.id}`
    // Warmed while the ending plays, so the profile is there when we get to
    // it rather than the caller watching a spinner replace a dead call.
    router.prefetch(profile)
    leaveRef.current = setTimeout(() => {
      leaveRef.current = null
      router.push(profile)
    }, ENDED_HOLD_MS)
  }, [agent.id, call, router])

  const header = (
    <PageHeader
      className="shrink-0"
      title={`Calling ${agent.name}`}
      description={`${agent.title} · web call · everything said here lands on the call record and the run.`}
    />
  )

  if (!call) {
    return (
      <CallScreen>
        {header}
        <Card className="flex min-h-0 flex-col lg:flex-1">
          <CardContent className="flex min-h-0 flex-1 flex-col items-center gap-6 px-6 py-6">
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
              <div className="bh-call-enter flex shrink-0 flex-col items-center gap-3 text-center">
                <p className="max-w-md text-sm text-fg-muted">{placeError}</p>
                <Button type="button" onClick={place}>
                  <Phone className="mr-1.5 size-4" /> Try again
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </CallScreen>
    )
  }

  return (
    <CallScreen>
      {header}
      <LiveKitRoom
        // The room's own container is a link in the height chain — everything
        // on the call hangs off it — so it fills the screen the same way the
        // dialling card does.
        className="flex min-h-0 flex-col lg:flex-1"
        serverUrl={serverUrl}
        token={call.token}
        audio
        video={false}
        options={ROOM_OPTIONS}
        // Hanging up releases the room in the same breath: the microphone
        // stops, the agent's voice stops, and the caller is left with the
        // resolved stage rather than a line that is somehow still open.
        connect={!closed}
        // The room disconnecting is a normal end of call — the agent hangs up
        // by deleting the room, and a dropped connection arrives the same way
        // — so it lands on the same ending, never on an error. When it is the
        // echo of our own hang-up, the exactly-once guard swallows it.
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
    </CallScreen>
  )
}
