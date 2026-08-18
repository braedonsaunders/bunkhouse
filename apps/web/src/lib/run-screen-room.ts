import 'server-only'
import { randomUUID } from 'node:crypto'
import { Room } from '@livekit/rtc-node'
import { mintLiveKitToken } from '@braedonsaunders/appkit-voice'
import { registerBrowserCast } from './browser-cast'
import { agentScreenOpener } from './call-screen'

export function runScreenRoomName(runId: string): string {
  return `work-${runId}`
}

/**
 * Offer a normal governed run the same damage-driven LiveKit screen track a
 * call already gets. The room connection and encoder are both lazy: a run
 * that never opens a browser pays nothing beyond registering this function.
 */
export function registerRunScreenRoom(args: {
  tenantId: string
  runId: string
  onError: (message: string) => void
}): (() => Promise<void>) | null {
  const serverUrl = process.env.LIVEKIT_URL
  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET
  if (!serverUrl || !apiKey || !apiSecret) return null

  let room: Room | null = null
  let roomOpening: Promise<Room> | null = null
  let stopped = false
  const openRoom = async (): Promise<Room> => {
    if (stopped) throw new Error('The live work room has closed.')
    if (room) return room
    if (!roomOpening) {
      roomOpening = (async () => {
        const connected = new Room()
        const token = await mintLiveKitToken(
          { apiKey, apiSecret },
          {
            identity: `agent-screen:${args.runId}:${randomUUID()}`,
            name: 'Agent screen',
            room: runScreenRoomName(args.runId),
            metadata: JSON.stringify({ tenantId: args.tenantId, runId: args.runId, kind: 'work-screen' }),
            canPublish: true,
            canSubscribe: false,
          },
        )
        await connected.connect(serverUrl, token)
        if (stopped) {
          await connected.disconnect().catch(() => undefined)
          throw new Error('The live work room closed while it was connecting.')
        }
        room = connected
        return connected
      })().finally(() => {
        roomOpening = null
      })
    }
    return roomOpening
  }
  const stopCast = registerBrowserCast(args.runId, async (size) => {
    const connected = await openRoom()
    return agentScreenOpener({ room: connected, onError: args.onError })(size)
  })

  return async () => {
    if (stopped) return
    stopped = true
    await stopCast()
    await roomOpening?.catch(() => undefined)
    const connected = room
    room = null
    await connected?.disconnect().catch(() => undefined)
  }
}
