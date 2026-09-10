import 'server-only'
import { requireTenantPermission } from '../../../../../lib/tenant'
import { parseDeskInput, sendDesktopInput } from '../../../../../lib/chat-desk'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * One input on the agent's screen, in the desk-v1 shape.
 *
 * A route rather than a server action, and that is the whole point. Server
 * actions share ONE queue per client: they may revalidate, so the client
 * applies them in order and will not start the next until the last has come
 * back. Taking control put every click and keystroke into that queue behind the
 * two polls that also lived there — the work surface's (a second, reading up to
 * a hundred runs and two hundred run events with their payloads) and the desk's
 * own status read. Once a poll outlasted its interval the queue grew, and the
 * person driving the screen waited tens of seconds for a click to land.
 *
 * Nothing about the gates changes: the same `sendDesktopInput` in
 * lib/chat-desk.ts, so session, tenant, the `desk` and `desktop` feature gates
 * and the agent's `desktop` autonomy dial are all still checked there, the
 * takeover is still recorded on the run, and the runner's address and token
 * never leave this tier. Only the transport is different — a plain POST, which
 * is not serialized against anything.
 *
 * This is also why the frame endpoint next door is a route: the same reasoning,
 * reached earlier for pictures than for pointer input.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ personId: string }> },
): Promise<Response> {
  const { personId } = await params
  const access = await requireTenantPermission('work.manage')
  if (!personId) return problem('No agent selected.')

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return problem('That request could not be read.')
  }
  const parsed = parseDeskInput((payload as { action?: unknown } | null)?.action)
  if (!parsed) return problem('That is not something the screen can be asked to do.')

  const outcome = await sendDesktopInput({
    tenantId: access.tenantId,
    personId,
    actor: { name: access.user.name.trim() || access.user.email },
    action: parsed,
  })
  // A refusal is an ordinary answer here — a closed screen, a dial that says
  // no — so the console can show it rather than treating it as a broken request.
  return Response.json(outcome, { status: 'error' in outcome ? 409 : 200 })
}

function problem(message: string): Response {
  return Response.json({ error: message }, { status: 400 })
}
