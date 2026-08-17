import 'server-only'
import { requireTenantPermission } from '../../../../../lib/tenant'
import { deskFrames } from '../../../../../lib/chat-desk'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The agent's desktop, live, in a browser.
 *
 * A server-side proxy and nothing more: the desk runner's address and bearer
 * token never leave this tier. Every gate is passed BEFORE a single byte is
 * proxied — an active session with `work.read`, the tenant the agent actually
 * belongs to, the `desk` and `desktop` feature gates, and the agent's own
 * autonomy dial for `desktop` (lib/chat-desk.ts holds all of them, once).
 *
 * Transport is SSE, chosen over polling a PNG because the runner already
 * speaks SSE off a damage-driven capture: a still screen costs nothing at all
 * on the wire, and a screen being typed into arrives as it happens rather than
 * a frame per poll interval whether or not anything changed. Each record is
 *
 *     data: {"png":"<base64>","width":1280,"height":900,"seq":41}
 *
 * plus the runner's keepalive comments, forwarded so nothing between here and
 * the browser decides an idle connection is a dead one.
 *
 * Subscribing is what starts the guest capturing, and the last unsubscribe is
 * what stops it — so a closed tab stops the pump rather than leaving the guest
 * painting for nobody. That is why `request.signal` is wired straight through
 * to the upstream fetch.
 *
 * While a handover is live the guest withholds every frame (§3.14), so this
 * stream simply goes quiet for its duration. That is the mask working, not a
 * fault, and nothing here may be pointed at a rawer source to "fix" it.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ personId: string }> },
): Promise<Response> {
  const { personId } = await params
  const access = await requireTenantPermission('work.read')
  const opened = await deskFrames({
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
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      // Proxies that buffer an event stream turn a live view into a slideshow.
      'x-accel-buffering': 'no',
    },
  })
}
