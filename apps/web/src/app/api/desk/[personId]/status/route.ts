import 'server-only'
import { requireTenantPermission } from '../../../../../lib/tenant'
import { deskStatus } from '../../../../../lib/chat-desk'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * What the agent's desk is currently doing.
 *
 * A route for the same reason as `input` beside it: this is polled, and a poll
 * on the server-action queue is a poll in front of the reader's own clicks. The
 * agent opens and closes its own screen mid-turn, so this has to be re-asked
 * rather than waited for — which makes it exactly the kind of traffic that must
 * not compete with pointer input.
 *
 * Same gate and same answer shape as before, from the same `deskStatus` in
 * lib/chat-desk.ts; a status this tier cannot determine is still a status,
 * carrying its own reason, so the console never has to guess.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ personId: string }> },
): Promise<Response> {
  const { personId } = await params
  const access = await requireTenantPermission('work.read')
  if (!personId) {
    return Response.json(
      { supported: false, desk: false, desktop: false, screenRunning: false, reason: 'No agent selected.' },
      { headers: { 'cache-control': 'no-store' } },
    )
  }
  const status = await deskStatus({ tenantId: access.tenantId, personId })
  // Every poll wants the desk as it is now; a cached status is a lie, exactly as
  // a cached frame is.
  return Response.json(status, { headers: { 'cache-control': 'no-store' } })
}
