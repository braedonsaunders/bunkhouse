import { revalidatePath } from 'next/cache'
import { completeFilingOauth, filingOauthRedirectUri } from '../../../../lib/filing'
import { appUrl } from '../../../../lib/app-origin'

export const dynamic = 'force-dynamic'

/**
 * Where somebody lands after authorising a storage provider.
 *
 * Filing has not had a page of its own since settings became one screen with
 * sections — it is `?section=filing` now — so this was sending everybody who
 * finished connecting Drive or Dropbox to a 404, success and failure alike.
 * The message in the query string went with them.
 *
 * Deliberately NOT built from `request.url`: inside a container that is the
 * address the server bound to, not the address the browser came from, so a
 * redirect built on it lands nowhere.
 */
async function backToFiling(params: { error?: string; notice?: string }): Promise<Response> {
  const target = new URL(await appUrl(FILING_SETTINGS))
  target.searchParams.set('section', 'filing')
  if (params.error) target.searchParams.set('filingError', params.error)
  if (params.notice) target.searchParams.set('filingNotice', params.notice)
  return Response.redirect(target, 302)
}

/** The page filing settings actually live on. */
const FILING_SETTINGS = '/admin/settings'

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
    return await backToFiling({ error: 'That connection could not be verified. Start again from Settings → Filing.' })
  }
  if (denied) return await backToFiling({ error: `The connection was not completed: ${denied}` })
  if (!code) return await backToFiling({ error: 'The provider did not return an authorization code.' })

  const result = await completeFilingOauth({ state, code, redirectUri: await filingOauthRedirectUri() })
  if (!result.ok) return await backToFiling({ error: result.message })

  revalidatePath(FILING_SETTINGS)
  return await backToFiling({ notice: `Connected. New files are filed to ${result.detail}.` })
}
