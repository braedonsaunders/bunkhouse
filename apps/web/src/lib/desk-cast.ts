import 'server-only'
import { Buffer } from 'node:buffer'
import sharp from 'sharp'
import { AGENT_SCREEN_FPS, AGENT_SCREEN_HEIGHT, AGENT_SCREEN_WIDTH } from './agent-screen'
import {
  agentScreenOpenerFor,
  exactBytes,
  trackLiveCast,
  type AgentScreenPublisher,
  type BrowserCast,
} from './browser-cast'

/**
 * Casting the agent's DESK — the desktop half of the live view (§3.13).
 *
 * This is `browser-cast.ts` for the microVM. That file takes frames from
 * Chromium's CDP screencast; this one takes them from the guest's own
 * compositor capture, relayed out by the desk-runner as server-sent events.
 * Everything downstream is shared and unchanged: the same publisher opener
 * registered by the call (`registerBrowserCast`), the same track contract in
 * `agent-screen.ts`, the same LiveKit plumbing in `call-screen.ts`. Nothing
 * about the transport is forked — a desk and a browser are two sources for
 * one stage.
 *
 * Two things follow from where the frames come from, and both matter:
 *
 *   1. **The mask holds.** The runner reads frames from `@appkit/desk`'s
 *      `handle.screen.frames()`, which withholds every frame while a handover
 *      is active. So when a person takes the screen, this cast goes quiet at
 *      the source — not because anything here checks, but because there is
 *      nothing to relay. Nothing in this file can undo that, and nothing in
 *      this file should ever be pointed at a rawer source.
 *
 *   2. **Nothing rescales in the ordinary case.** The guest is asked to
 *      capture at exactly AGENT_SCREEN_WIDTH × AGENT_SCREEN_HEIGHT, which is
 *      the size the desktop itself runs at and the size the track publishes
 *      at. The resize below is a no-op then, and a correction only when the
 *      compositor hands back something else.
 *
 * Who receives the frames is injected, exactly as it is for the browser. A
 * call registers an opener for its run; an email run or a scheduled duty
 * registers nothing, so `startDeskCast` returns null and opening a desktop
 * costs no capture, no encode and no socket.
 */

export type DeskCastRunner = { url: string; token: string }

export type DeskCastArgs = {
  runId: string
  deskId: string
  runner: DeskCastRunner
  fetch?: typeof fetch
}

/** The desk casts currently running, one per run at most. */
type DeskCastRegistry = typeof globalThis & { __bunkhouseDeskCasts?: Map<string, BrowserCast> }
const registry = globalThis as DeskCastRegistry

function deskCasts(): Map<string, BrowserCast> {
  return (registry.__bunkhouseDeskCasts ??= new Map())
}

/**
 * One frame as the runner streams it: an encoded image, base64, plus its size.
 *
 * The encoding is deliberately NOT read here. sharp sniffs the format out of
 * the bytes, so a guest that switched from PNG to JPEG — which it has, because
 * a whole PNG per tick is what the guest→host link could not carry — needs no
 * change on this side. What must not happen is this file starting to ASSUME
 * one: the runner reports `format` on every frame for a consumer that has to
 * name a media type, and this one does not.
 */
type WireFrame = { seq: number; width: number; height: number; data: string }

function parseWireFrame(payload: string): WireFrame | null {
  try {
    const value = JSON.parse(payload) as Partial<WireFrame>
    if (typeof value.data !== 'string' || !value.data) return null
    return {
      seq: typeof value.seq === 'number' ? value.seq : 0,
      width: typeof value.width === 'number' ? value.width : AGENT_SCREEN_WIDTH,
      height: typeof value.height === 'number' ? value.height : AGENT_SCREEN_HEIGHT,
      data: value.data,
    }
  } catch {
    return null
  }
}

/**
 * Start casting this desk's screen, if anyone registered to watch this run.
 * Idempotent per run: opening a desktop twice does not open a second track.
 * Returns null when nobody is watching — the ordinary case.
 */
export async function startDeskCast(args: DeskCastArgs): Promise<BrowserCast | null> {
  const { runId, deskId, runner } = args
  const existing = deskCasts().get(runId)
  if (existing) return existing
  const opener = agentScreenOpenerFor(runId)
  if (!opener) return null

  const width = AGENT_SCREEN_WIDTH
  const height = AGENT_SCREEN_HEIGHT
  const request = args.fetch ?? fetch

  let publisher: AgentScreenPublisher
  try {
    publisher = await opener({ width, height })
  } catch {
    // Publishing is a nicety; a desktop session is not failed over it.
    return null
  }

  const abort = new AbortController()
  let stopped = false
  let untrack: () => void = () => {}
  let converting = false

  const cast: BrowserCast = {
    stop: async () => {
      if (stopped) return
      stopped = true
      abort.abort()
      untrack()
      if (deskCasts().get(runId) === cast) deskCasts().delete(runId)
      // Best effort: the desk may already be gone, which is exactly when this
      // runs. The pump stops on its own when the last subscriber leaves.
      await request(`${runner.url}/desks/${encodeURIComponent(deskId)}/screen/frames/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${runner.token}` },
        body: '{}',
        signal: AbortSignal.timeout(5_000),
      }).catch(() => undefined)
      await publisher.close().catch(() => undefined)
    },
  }

  const stream = `${runner.url}/desks/${encodeURIComponent(deskId)}/screen/frames` +
    `?fps=${AGENT_SCREEN_FPS}&width=${width}&height=${height}`

  let response: Response
  try {
    response = await request(stream, {
      headers: { authorization: `Bearer ${runner.token}`, accept: 'text/event-stream' },
      signal: abort.signal,
    })
    if (!response.ok || !response.body) throw new Error(`the runner refused the frame stream (${response.status})`)
  } catch (error) {
    await publisher.close().catch(() => undefined)
    throw error instanceof Error ? error : new Error(String(error))
  }

  untrack = trackLiveCast(runId, cast)
  deskCasts().set(runId, cast)

  void (async () => {
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done || stopped) break
        buffered += decoder.decode(value, { stream: true })
        // SSE: records are separated by a blank line; comment lines (the
        // keepalive a still screen produces) start with a colon and are
        // dropped without a thought.
        let boundary = buffered.indexOf('\n\n')
        while (boundary !== -1) {
          const record = buffered.slice(0, boundary)
          buffered = buffered.slice(boundary + 2)
          boundary = buffered.indexOf('\n\n')
          const payload = record
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('')
          if (!payload) continue
          const frame = parseWireFrame(payload)
          if (!frame) continue
          // Back-pressure is a drop, never a queue — the same rule the
          // browser cast follows, for the same reason: the picture of the
          // work must never be able to slow the work down.
          if (converting) continue
          converting = true
          void sharp(Buffer.from(frame.data, 'base64'))
            // Anchored top-left, like the browser cast: a frame that arrives a
            // few pixels off should look like the screen shifted, not like the
            // whole view jumped.
            .resize({ width, height, fit: 'contain', position: 'left top', background: '#000000' })
            .ensureAlpha()
            .raw()
            .toBuffer()
            .then((raw) => {
              if (stopped) return
              publisher.publish({ data: exactBytes(raw), width, height })
            })
            .catch(() => {
              // One frame that would not decode is one frame; the next
              // repaint is the retry.
            })
            .finally(() => {
              converting = false
            })
        }
      }
    } catch {
      // A dropped stream ends the cast; it does not end the desktop session.
    } finally {
      await cast.stop().catch(() => undefined)
    }
  })()

  return cast
}

/** Stop this run's desk cast, if one is running. Idempotent. */
export async function stopDeskCast(runId: string): Promise<void> {
  await deskCasts().get(runId)?.stop()
}
