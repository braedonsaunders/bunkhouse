import 'server-only'
import { runDashboardBridge } from '../../../../../../lib/chat-dashboard'
import { requireTenantPermission } from '../../../../../../lib/tenant'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const MAX_BRIDGE_REQUEST_CHARS = 128 * 1_024

/**
 * Stable transport from an installed dashboard frame to its governed host
 * bridge. Dashboard JavaScript may poll this route without inheriting the
 * deployment-specific identity and client-side queue of a Server Action.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ threadId: string }> },
): Promise<Response> {
  const { threadId } = await params
  const access = await requireTenantPermission('work.read')
  if (!threadId) return problem('No conversation selected.')

  let text: string
  try {
    text = await request.text()
  } catch {
    return problem('That dashboard request could not be read.')
  }
  if (text.length > MAX_BRIDGE_REQUEST_CHARS) return problem('That dashboard request is too large.', 413)

  let input: unknown
  try {
    input = JSON.parse(text)
  } catch {
    return problem('That dashboard request could not be read.')
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return problem('That dashboard request could not be read.')
  }
  const { method, payload } = input as { method?: unknown; payload?: unknown }
  if (typeof method !== 'string' || !method.trim() || method.length > 100) {
    return problem('That dashboard method is not valid.')
  }

  try {
    const result = await runDashboardBridge({
      tenantId: access.tenantId,
      user: { id: access.user.id, name: access.user.name },
      threadId,
      method,
      payload,
    })
    return Response.json({ result }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (reason) {
    return problem(reason instanceof Error ? reason.message : 'The dashboard could not load live data.', 400)
  }
}

function problem(message: string, status = 400): Response {
  return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'private, no-store' } })
}
