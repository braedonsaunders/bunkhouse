import { revalidatePath } from 'next/cache'
import { completeMcpOauth } from '../../../../lib/mcp-oauth'

export const dynamic = 'force-dynamic'

function backToSettings(request: Request, params: Record<string, string>): Response {
  const target = new URL('/admin/settings', request.url)
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value)
  return Response.redirect(target, 302)
}

/**
 * The one redirect URI every MCP OAuth sign-in comes back to. Authorization
 * is proved by the sealed state rather than by the session — the state names
 * the tenant and the pending round-trip, and expires after ten minutes. The
 * exchange, the connection probe, and the save all happen in completeMcpOauth;
 * this route only translates the outcome into a redirect the operator reads.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams
  const state = params.get('state') ?? ''
  const code = params.get('code') ?? ''
  const denied = params.get('error_description') ?? params.get('error')

  if (denied) return backToSettings(request, { mcpOauthError: `Sign-in was not completed: ${denied}` })
  if (!state || !code) {
    return backToSettings(request, {
      mcpOauthError: 'The provider did not return a sign-in code. Start the connection again.',
    })
  }

  const result = await completeMcpOauth({ state, code })
  if (!result.ok) return backToSettings(request, { mcpOauthError: result.message })

  revalidatePath('/admin/settings')
  return backToSettings(request, { mcpOauthConnected: result.label, mcpOauthTools: String(result.toolCount) })
}
