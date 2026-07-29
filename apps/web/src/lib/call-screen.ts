import 'server-only'
import {
  LocalVideoTrack,
  TrackPublishOptions,
  TrackSource,
  VideoBufferType,
  VideoCodec,
  VideoFrame,
  VideoSource,
  type LocalTrackPublication,
  type Room,
} from '@livekit/rtc-node'
import { AGENT_SCREEN_FPS, AGENT_SCREEN_TRACK_NAME } from './agent-screen'
import type { AgentScreenOpener } from './browser-cast'

/**
 * The agent's browser, published into the call as a video track.
 *
 * The agent is already a participant in the caller's room. Its browser is a
 * picture that changes ten times a second. Putting the second inside the first
 * is the whole design: the caller's page already renders LiveKit tracks, so
 * they get smooth live video — the page scrolling, the cursor crossing it, the
 * text going in — with no polling, no new transport, and no new service.
 *
 * Only calls. `registerBrowserCast` is what turns this on, and only the voice
 * agent calls it, for the run its call owns. An email run or a scheduled duty
 * registers nothing, so its browser opens no video source at all.
 *
 * Imported only by the voice agent process; the web app never bundles this.
 */

/**
 * Ceiling on the bitrate one agent screen may take. A page of text at 10fps
 * settles well under this — most frames are a cursor moving over pixels that
 * did not change — but a video playing inside the page would otherwise take
 * whatever the connection would give it, on a call whose actual job is audio.
 */
const MAX_BITRATE = 2_000_000n

/**
 * Build the opener a browser session asks for when it starts. One call, one
 * room; the track itself is not created until a browser actually opens, so a
 * call where the agent never browses publishes nothing and costs nothing.
 */
export function agentScreenOpener(args: {
  room: Room
  /** Operator-facing log line for anything that goes wrong. */
  onError: (message: string) => void
}): AgentScreenOpener {
  const { room, onError } = args

  return async ({ width, height }) => {
    // Only set once the room is connected. The browser can only open after the
    // agent has answered, so this is present in practice — and saying so
    // plainly beats publishing into nothing if it ever is not.
    const me = room.localParticipant
    if (!me) throw new Error('The call is not connected, so the agent’s screen cannot be published.')

    const source = new VideoSource(width, height)
    const track = LocalVideoTrack.createVideoTrack(AGENT_SCREEN_TRACK_NAME, source)
    let publication: LocalTrackPublication | null = null
    try {
      publication = await me.publishTrack(
        track,
        new TrackPublishOptions({
          // A screen share, because that is what it is — and because a server
          // told it is a camera degrades it resolution-first, which is exactly
          // wrong for a picture whose entire content is small text. The track
          // name is what distinguishes it from a human guest sharing a screen
          // into the same room; see AGENT_SCREEN_TRACK_NAME.
          source: TrackSource.SOURCE_SCREENSHARE,
          // VP8: universally decodable in every browser that can join a call,
          // and cheap to encode in software, which is all this process has.
          videoCodec: VideoCodec.VP8,
          videoEncoding: { maxBitrate: MAX_BITRATE, maxFramerate: AGENT_SCREEN_FPS },
          // One layer. Simulcast buys a choice of resolutions nobody wants
          // here — the stage shows this at one size — and costs several
          // encoders on a process that is also holding a conversation.
          simulcast: false,
        }),
      )
    } catch (error) {
      await track.close().catch(() => {})
      throw error
    }

    const startedAt = process.hrtime.bigint()
    let closed = false

    return {
      publish: (frame) => {
        if (closed) return
        try {
          source.captureFrame(
            new VideoFrame(frame.data, frame.width, frame.height, VideoBufferType.RGBA),
            // Microseconds since the first frame: the encoder paces itself off
            // these, and a stream of zeroes makes every frame look instant.
            (process.hrtime.bigint() - startedAt) / 1000n,
          )
        } catch (error) {
          // A capture that fails is one frame. It must never propagate into the
          // screencast handler, which runs on the same loop as the agent's work.
          onError(`A frame of the agent's screen could not be sent: ${(error as Error).message}`)
        }
      },
      close: async () => {
        if (closed) return
        closed = true
        // Unpublish first, so the caller's stage stops showing a screen the
        // agent has walked away from; then release the encoder and the source.
        if (publication?.sid) {
          await me.unpublishTrack(publication.sid, true).catch((error: unknown) => {
            onError(`The agent's screen could not be unpublished: ${(error as Error).message}`)
          })
        }
        await track.close(true).catch(() => {})
      },
    }
  }
}
