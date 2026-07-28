'use client'

import * as React from 'react'
import { Mic, MicOff, MonitorOff, MonitorUp, PhoneOff, Video, VideoOff } from 'lucide-react'
import {
  LiveKitRoom,
  RoomAudioRenderer,
  VideoTrack,
  useConnectionState,
  useRemoteParticipants,
  useTrackToggle,
  useTracks,
} from '@livekit/components-react'
import { ConnectionState, Track } from 'livekit-client'
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, PageHeader } from '@appkit/ui'
import { joinMeetingAction, leaveMeetingAction } from '../app/meet/actions'

const CONNECTION_LABELS: Record<string, string> = {
  [ConnectionState.Connecting]: 'connecting',
  [ConnectionState.Connected]: 'connected',
  [ConnectionState.Reconnecting]: 'reconnecting',
  [ConnectionState.Disconnected]: 'disconnected',
  [ConnectionState.SignalReconnecting]: 'reconnecting',
}

/** One media control, wired to the room's own toggle state. */
function MediaToggle({
  source,
  onLabel,
  offLabel,
  OnIcon,
  OffIcon,
}: {
  source: Track.Source.Microphone | Track.Source.Camera | Track.Source.ScreenShare
  onLabel: string
  offLabel: string
  OnIcon: typeof Mic
  OffIcon: typeof MicOff
}) {
  const { enabled, pending, toggle } = useTrackToggle({ source })
  const Icon = enabled ? OnIcon : OffIcon
  return (
    <Button type="button" variant={enabled ? 'outline' : 'secondary'} disabled={pending} onClick={() => void toggle()}>
      <Icon className="mr-1.5 size-4" />
      {enabled ? onLabel : offLabel}
    </Button>
  )
}

/** Everyone's video, screens included — the screen is the point of the meeting. */
function Tiles({ agentName }: { agentName: string }) {
  const tracks = useTracks([Track.Source.ScreenShare, Track.Source.Camera])
  if (tracks.length === 0) {
    return (
      <div className="flex min-h-[16rem] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-bg-subtle p-8 text-center">
        <p className="text-sm font-medium text-fg">No video yet</p>
        <p className="max-w-md text-sm text-fg-muted">
          Turn on your camera, or share your screen to walk {agentName} through what you are looking at. Talking works
          either way.
        </p>
      </div>
    )
  }
  return (
    <div className={`grid gap-3 ${tracks.length > 1 ? 'md:grid-cols-2' : 'grid-cols-1'}`}>
      {tracks.map((trackRef) => (
        <figure
          key={`${trackRef.participant.identity}-${trackRef.source}`}
          className="overflow-hidden rounded-lg border border-border bg-bg-subtle"
        >
          <VideoTrack trackRef={trackRef} className="aspect-video w-full bg-black object-contain" />
          <figcaption className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-fg-muted">
            <span className="truncate">{trackRef.participant.name || trackRef.participant.identity}</span>
            {trackRef.source === Track.Source.ScreenShare ? <Badge variant="outline">screen</Badge> : null}
          </figcaption>
        </figure>
      ))}
    </div>
  )
}

function Stage({ agentName, onLeave, leaving }: { agentName: string; onLeave: () => void; leaving: boolean }) {
  const connection = useConnectionState()
  const remotes = useRemoteParticipants()
  const agentJoined = remotes.length > 0
  return (
    <div className="space-y-4">
      <Tiles agentName={agentName} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            In the meeting
            <Badge variant={connection === ConnectionState.Connected ? 'default' : 'outline'}>
              {CONNECTION_LABELS[connection] ?? connection}
            </Badge>
          </CardTitle>
          <CardDescription>
            {connection !== ConnectionState.Connected
              ? 'Connecting you to the room…'
              : agentJoined
                ? `${agentName} is here and can hear you. Share your screen whenever you are ready.`
                : `Waiting for ${agentName} to join…`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <MediaToggle
            source={Track.Source.Microphone}
            onLabel="Mic on"
            offLabel="Mic off"
            OnIcon={Mic}
            OffIcon={MicOff}
          />
          <MediaToggle
            source={Track.Source.Camera}
            onLabel="Camera on"
            offLabel="Camera off"
            OnIcon={Video}
            OffIcon={VideoOff}
          />
          <MediaToggle
            source={Track.Source.ScreenShare}
            onLabel="Sharing screen"
            offLabel="Share screen"
            OnIcon={MonitorUp}
            OffIcon={MonitorOff}
          />
          <Button type="button" variant="destructive" onClick={onLeave} disabled={leaving}>
            <PhoneOff className="mr-1.5 size-4" /> {leaving ? 'Leaving…' : 'Leave meeting'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * The guest's whole meeting: a name, a click, and they are in a room with the
 * agent — camera, microphone, and screen share, with no account and nothing
 * to install. What is said lands on the meeting record, and anything shared
 * on screen is captured to it as evidence.
 */
export function MeetingRoom({
  serverUrl,
  token,
  agent,
  purpose,
}: {
  serverUrl: string
  /** The invitation token from the URL — the credential for every action here. */
  token: string
  agent: { id: string; name: string; title: string }
  purpose?: string
}) {
  const [name, setName] = React.useState('')
  const [room, setRoom] = React.useState<{ token: string } | null>(null)
  const [joining, setJoining] = React.useState(false)
  const [joinError, setJoinError] = React.useState<string | null>(null)
  const [leaving, setLeaving] = React.useState(false)
  const [left, setLeft] = React.useState(false)
  const leftRef = React.useRef(false)

  const join = React.useCallback(async () => {
    setJoining(true)
    setJoinError(null)
    try {
      setRoom(await joinMeetingAction(token, name))
    } catch (error) {
      setJoinError(error instanceof Error ? error.message : 'The meeting could not be joined.')
    } finally {
      setJoining(false)
    }
  }, [name, token])

  const leave = React.useCallback(async () => {
    if (leftRef.current) return
    leftRef.current = true
    setLeaving(true)
    try {
      await leaveMeetingAction(token)
    } finally {
      setLeaving(false)
      setRoom(null)
      setLeft(true)
    }
  }, [token])

  const header = (
    <PageHeader
      title={`Meeting with ${agent.name}`}
      description={`${agent.title} · everything said here lands on the meeting record.`}
    />
  )

  if (left) {
    return (
      <div className="space-y-6">
        {header}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">You have left the meeting</CardTitle>
            <CardDescription>
              Thank you — {agent.name} has what was shared and will follow up by email. You can close this tab.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  if (!room) {
    return (
      <div className="space-y-6">
        {header}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Ready to join</CardTitle>
            <CardDescription>
              {purpose
                ? `${purpose} — joining connects your microphone; your camera and screen stay off until you turn them on.`
                : 'Joining connects your microphone; your camera and screen stay off until you turn them on.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="max-w-sm space-y-2">
              <Label htmlFor="meeting-guest-name">Your name</Label>
              <Input
                id="meeting-guest-name"
                value={name}
                placeholder="How should we call you?"
                autoComplete="name"
                maxLength={60}
                onChange={(event) => setName(event.target.value)}
              />
              <p className="text-sm text-fg-muted">This is the name {agent.name} sees in the meeting.</p>
            </div>
            {joinError ? <p className="text-sm text-danger">{joinError}</p> : null}
            <Button type="button" onClick={() => void join()} disabled={joining}>
              <Video className="mr-1.5 size-4" /> {joining ? 'Joining…' : 'Join meeting'}
            </Button>
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
        token={room.token}
        audio
        video={false}
        connect
        onDisconnected={() => void leave()}
      >
        <RoomAudioRenderer />
        <Stage agentName={agent.name} onLeave={() => void leave()} leaving={leaving} />
      </LiveKitRoom>
    </div>
  )
}
