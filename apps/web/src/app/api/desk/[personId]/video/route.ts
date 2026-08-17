import 'server-only'
import { requireTenantPermission } from '../../../../../lib/tenant'
import { deskVideo } from '../../../../../lib/chat-desk'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The agent's desktop, live, as video.
 *
 * A server-side proxy and nothing more: the desk runner's address and bearer
 * token never leave this tier. Every gate is passed BEFORE a single byte is
 * proxied — an active session with `work.read`, the tenant the agent actually
 * belongs to, the `desk` and `desktop` feature gates, and the agent's own
 * autonomy dial for `desktop` (lib/chat-desk.ts holds all of them, once).
 *
 * Transport is a plain streaming response carrying BINARY chunks, not SSE and
 * not a websocket.
 *
 *   · Not SSE, because this is a continuous byte stream rather than a sequence
 *     of records: base64 inside a text event would add a third again to the
 *     one path the whole design exists to make cheap.
 *   · Not a websocket, because the browser must reach the runner THROUGH this
 *     gate, and an App Router route handler cannot carry an upgrade. Handing
 *     the page a direct websocket URL is how the handover relay works, but that
 *     URL carries the runner's bearer token — acceptable for a deliberate,
 *     TTL-bounded grant, and not for a live view every watcher opens.
 *
 * The framing is the runner's `encodeVideoWireChunk`: an 8-byte header and a
 * fragmented-MP4 payload, passed through here untouched.
 *
 * Subscribing is what starts the guest encoding, and the last unsubscribe is
 * what stops it — so a closed tab stops the encode rather than leaving the
 * guest painting for nobody. That is why `request.signal` is wired straight
 * through to the upstream fetch.
 *
 * While a handover is live the guest withholds everything (§3.14), so this
 * stream simply goes quiet for its duration. That is the mask working, not a
 * fault, and nothing here may be pointed at a rawer source to "fix" it.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ personId: string }> },
): Promise<Response> {
  const { personId } = await params
  const access = await requireTenantPermission('work.read')
  const opened = await deskVideo({
    tenantId: access.tenantId,
    personId,
    signal: request.signal,
  })
  if ('error' in opened) {
    return new Response(JSON.stringify({ error: opened.error }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response(opened.stream, {
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      // A proxy that buffers this turns a live view into a slideshow.
      'x-accel-buffering': 'no',
    },
  })
}
