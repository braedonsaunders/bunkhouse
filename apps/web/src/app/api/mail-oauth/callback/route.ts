import { revalidatePath } from 'next/cache'
import { completeMailOauth, mailOauthRedirectUri, mailOauthStatePerson } from '../../../../lib/mail-oauth'
import { appUrl } from '../../../../lib/app-origin'

export const dynamic = 'force-dynamic'

/**
 * Deliberately NOT built from `request.url`: inside a container that is the
 * address the server bound to, not the address the browser came from, so a
 * redirect built on it lands nowhere.
 */
async function backToAgent(personId: string | null, error?: string): Promise<Response> {
  const target = new URL(await appUrl('/organization'))
  if (personId) target.searchParams.set('person', personId)
  if (error) target.searchParams.set('mailboxError', error)
  return Response.redirect(target, 302)
}

/**
 * The single redirect URI both providers call back to. Authorization is proved
 * by the sealed state rather than by the session, so a callback that lands in
 * a different browser tab still completes; the state names the tenant, the
 * agent, and the provider, and expires after ten minutes.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams
  const state = params.get('state') ?? ''
  const code = params.get('code') ?? ''
  const denied = params.get('error_description') ?? params.get('error')

  if (!state) return await backToAgent(null, 'That sign-in could not be verified. Start the connection again.')
  if (denied) {
    return await backToAgent(mailOauthStatePerson(state), `Sign-in was not completed: ${denied}`)
  }
  if (!code) {
    return await backToAgent(mailOauthStatePerson(state), 'The provider did not return an authorization code.')
  }

  const result = await completeMailOauth({ state, code, redirectUri: await mailOauthRedirectUri() })
  if (!result.ok) return await backToAgent(result.personId, result.message)

  revalidatePath('/organization')
  revalidatePath('/admin/settings')
  return await backToAgent(result.personId)
}
