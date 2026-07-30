import { revalidatePath } from 'next/cache'
import { completeMcpOauth } from '../../../../lib/mcp-oauth'
import { appUrl } from '../../../../lib/app-origin'

export const dynamic = 'force-dynamic'

/**
 * Send the operator back to the Systems tab.
 *
 * Deliberately NOT built from `request.url`: inside a container that is the
 * address the server bound to — 0.0.0.0:3000 — not the address the browser
 * came from, so a redirect built on it lands nowhere. The public origin is
 * resolved the same way every other outward-facing URL here is.
 */
async function backToSystems(params: Record<string, string>): Promise<Response> {
  const target = new URL(await appUrl('/resources'))
  target.searchParams.set('tab', 'systems')
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

  if (denied) return backToSystems({ mcpOauthError: `Sign-in was not completed: ${denied}` })
  if (!state || !code) {
    return backToSystems({
      mcpOauthError: 'The provider did not return a sign-in code. Start the connection again.',
    })
  }

  const result = await completeMcpOauth({ state, code })
  if (!result.ok) return backToSystems({ mcpOauthError: result.message })

  revalidatePath('/resources')
  return backToSystems({ mcpOauthConnected: result.label, mcpOauthTools: String(result.toolCount) })
}
