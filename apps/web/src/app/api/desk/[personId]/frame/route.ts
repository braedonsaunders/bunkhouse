import 'server-only'
import { requireTenantPermission } from '../../../../../lib/tenant'
import { deskFrame } from '../../../../../lib/chat-desk'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * One still of the agent's desktop, as a PNG.
 *
 * The fallback for a deployment where the event stream next door cannot get
 * through — a proxy that buffers `text/event-stream`, a CDN that will not
 * carry it. `frames` (SSE) is the transport that should normally be used: the
 * guest's capture is damage-driven, so a still screen costs nothing there,
 * where polling pays for a picture per tick whether anything moved or not.
 *
 * Identical gates, from the same place (lib/chat-desk.ts): session, tenant,
 * the `desk` and `desktop` feature gates, and the agent's `desktop` autonomy
 * dial — all before the runner is contacted, and the runner's address and
 * token never leave this tier.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ personId: string }> },
): Promise<Response> {
  const { personId } = await params
  const access = await requireTenantPermission('work.read')
  const observed = await deskFrame({ tenantId: access.tenantId, personId })
  if ('error' in observed) {
    return new Response(JSON.stringify({ error: observed.error }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response(Buffer.from(observed.png, 'base64'), {
    headers: {
      'content-type': 'image/png',
      // Every poll wants the picture as it is now; a cached frame is a lie.
      'cache-control': 'no-store',
    },
  })
}
