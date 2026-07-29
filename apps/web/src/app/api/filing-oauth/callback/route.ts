import { revalidatePath } from 'next/cache'
import { completeFilingOauth, filingOauthRedirectUri } from '../../../../lib/filing'

export const dynamic = 'force-dynamic'

function backToFiling(request: Request, params: { error?: string; notice?: string }): Response {
  const target = new URL('/admin/settings/filing', request.url)
  if (params.error) target.searchParams.set('filingError', params.error)
  if (params.notice) target.searchParams.set('filingNotice', params.notice)
  return Response.redirect(target, 302)
}

/**
 * The single redirect URI both storage providers call back to. Authorization
 * is proved by the sealed state rather than by the session, so a callback that
 * lands in a different browser tab still completes; the state names the
 * company, the provider, and the folder that was asked for, and expires after
 * ten minutes.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams
  const state = params.get('state') ?? ''
  const code = params.get('code') ?? ''
  const denied = params.get('error_description') ?? params.get('error')

  if (!state) {
    return backToFiling(request, { error: 'That connection could not be verified. Start again from Settings → Filing.' })
  }
  if (denied) return backToFiling(request, { error: `The connection was not completed: ${denied}` })
  if (!code) return backToFiling(request, { error: 'The provider did not return an authorization code.' })

  const result = await completeFilingOauth({ state, code, redirectUri: await filingOauthRedirectUri() })
  if (!result.ok) return backToFiling(request, { error: result.message })

  revalidatePath('/admin/settings/filing')
  return backToFiling(request, { notice: `Connected. New files are filed to ${result.detail}.` })
}
