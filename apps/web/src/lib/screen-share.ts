import 'server-only'
import sharp from 'sharp'
import {
  RoomEvent,
  TrackSource,
  type Participant,
  VideoBufferType,
  VideoStream,
  type RemoteTrack,
  type RemoteTrackPublication,
  type Room,
  type VideoFrame,
  type VideoFrameEvent,
} from '@livekit/rtc-node'

/**
 * Watching a shared screen. When someone shares their screen in a meeting the
 * agent subscribes to that track like any other participant would, and samples
 * it: one still every few seconds, and only when the picture actually moved on.
 * Each still is a JPEG the caller puts on the record (doctrine #9 — what the
 * agent was shown is evidence, replayable after the meeting) and, where the
 * speech model takes images, the same still is what the agent is looking at.
 *
 * The sampling is deliberately frugal. A screen that is not changing produces
 * no frames at all, so a meeting spent talking over one static document costs
 * a single capture.
 */

/** How often the shared screen is sampled, at most. */
export const SCREEN_SAMPLE_INTERVAL_MS = 5_000

/** Longest edge of a stored still. Text stays legible; the bytes stay sane. */
const MAX_FRAME_WIDTH = 1280

const JPEG_QUALITY = 72

/** Sampled bytes per change signature — enough to see a window redraw. */
const SIGNATURE_SAMPLES = 1024

/** Per-sample intensity delta that counts as a real difference, 0–255. */
const SIGNATURE_TOLERANCE = 8

/** Share of samples that must differ before a frame is worth capturing. */
const CHANGE_RATIO = 0.02

export type CapturedScreenFrame = {
  /** Encoded JPEG bytes — what gets stored. */
  bytes: Uint8Array
  contentType: 'image/jpeg'
  /** The same bytes as a data URL, for models that take inline images. */
  dataUrl: string
  width: number
  height: number
  /** The participant whose screen this is. */
  participantIdentity: string
  participantName: string
}

/** A coarse fingerprint of a frame: evenly spaced samples of the raw pixels. */
function signatureOf(frame: VideoFrame): Uint8Array {
  const data = frame.data
  const step = Math.max(1, Math.floor(data.length / SIGNATURE_SAMPLES))
  const samples = new Uint8Array(SIGNATURE_SAMPLES)
  for (let i = 0; i < SIGNATURE_SAMPLES; i += 1) {
    samples[i] = data[i * step] ?? 0
  }
  return samples
}

/** Did enough of the picture change to be worth another still? */
function movedOn(previous: Uint8Array | null, next: Uint8Array): boolean {
  if (!previous || previous.length !== next.length) return true
  let differing = 0
  for (let i = 0; i < next.length; i += 1) {
    if (Math.abs((next[i] ?? 0) - (previous[i] ?? 0)) > SIGNATURE_TOLERANCE) differing += 1
  }
  return differing / next.length > CHANGE_RATIO
}

export type ScreenShareWatcher = {
  /** Stop reading every screen track and release the streams. */
  stop: () => Promise<void>
}

/**
 * Follow every screen-share track in the room for as long as the meeting
 * lasts. Tracks that are already subscribed when this is called are picked up
 * along with the ones that arrive later.
 */
export function watchScreenShare(options: {
  room: Room
  onFrame: (frame: CapturedScreenFrame) => Promise<void> | void
  onError?: (message: string) => void
  intervalMs?: number
}): ScreenShareWatcher {
  const intervalMs = options.intervalMs ?? SCREEN_SAMPLE_INTERVAL_MS
  const readers = new Map<string, ReadableStreamDefaultReader<VideoFrameEvent>>()
  let stopped = false

  const fail = (message: string) => {
    if (stopped) return
    options.onError?.(message)
  }

  const readTrack = async (key: string, track: RemoteTrack, identity: string, name: string) => {
    const reader = new VideoStream(track).getReader()
    readers.set(key, reader)
    let lastSampleAt = 0
    let previous: Uint8Array | null = null
    try {
      // Reading is sequential, so the frames that arrive while a still is being
      // encoded simply queue and are dropped by the interval check below —
      // sampling never falls behind the track.
      while (!stopped) {
        const { done, value } = await reader.read()
        if (done || !value) break
        const now = Date.now()
        if (now - lastSampleAt < intervalMs) continue
        lastSampleAt = now
        const source = value.frame
        const rgba = source.type === VideoBufferType.RGBA ? source : source.convert(VideoBufferType.RGBA)
        const signature = signatureOf(rgba)
        if (!movedOn(previous, signature)) continue
        previous = signature
        try {
          const bytes = await sharp(Buffer.from(rgba.data.buffer, rgba.data.byteOffset, rgba.data.byteLength), {
            raw: { width: rgba.width, height: rgba.height, channels: 4 },
          })
            .resize({ width: MAX_FRAME_WIDTH, withoutEnlargement: true })
            .jpeg({ quality: JPEG_QUALITY })
            .toBuffer()
          if (stopped) break
          await options.onFrame({
            bytes,
            contentType: 'image/jpeg',
            dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`,
            width: rgba.width,
            height: rgba.height,
            participantIdentity: identity,
            participantName: name,
          })
        } catch (error) {
          fail(`screen frame from ${name} could not be captured: ${(error as Error).message}`)
        }
      }
    } catch (error) {
      fail(`screen share from ${name} stopped unexpectedly: ${(error as Error).message}`)
    } finally {
      readers.delete(key)
    }
  }

  const isScreenShare = (publication: RemoteTrackPublication) =>
    publication.source === TrackSource.SOURCE_SCREENSHARE

  /** A publication's track sid, or the sharer's identity when it has none. */
  const keyFor = (publication: RemoteTrackPublication, identity: string) =>
    publication.sid ?? `${identity}:screenshare`

  const onSubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: Participant,
  ) => {
    const key = keyFor(publication, participant.identity)
    if (stopped || !isScreenShare(publication) || readers.has(key)) return
    void readTrack(key, track, participant.identity, participant.name || participant.identity)
  }

  const onUnsubscribed = (_track: RemoteTrack, publication: RemoteTrackPublication, participant: Participant) => {
    const key = keyFor(publication, participant.identity)
    const reader = readers.get(key)
    if (!reader) return
    readers.delete(key)
    void reader.cancel().catch(() => undefined)
  }

  options.room.on(RoomEvent.TrackSubscribed, onSubscribed)
  options.room.on(RoomEvent.TrackUnsubscribed, onUnsubscribed)
  for (const participant of options.room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      if (publication.track) onSubscribed(publication.track, publication, participant)
    }
  }

  return {
    stop: async () => {
      stopped = true
      options.room.off(RoomEvent.TrackSubscribed, onSubscribed)
      options.room.off(RoomEvent.TrackUnsubscribed, onUnsubscribed)
      const pending = Array.from(readers.values())
      readers.clear()
      await Promise.all(pending.map((reader) => reader.cancel().catch(() => undefined)))
    },
  }
}
