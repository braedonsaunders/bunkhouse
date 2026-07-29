import { revalidatePath } from 'next/cache'
import { completeMailOauth, mailOauthRedirectUri, mailOauthStatePerson } from '../../../../lib/mail-oauth'

export const dynamic = 'force-dynamic'

function backToAgent(request: Request, personId: string | null, error?: string): Response {
  const target = new URL('/organization', request.url)
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

  if (!state) return backToAgent(request, null, 'That sign-in could not be verified. Start the connection again.')
  if (denied) {
    return backToAgent(request, mailOauthStatePerson(state), `Sign-in was not completed: ${denied}`)
  }
  if (!code) {
    return backToAgent(request, mailOauthStatePerson(state), 'The provider did not return an authorization code.')
  }

  const result = await completeMailOauth({ state, code, redirectUri: await mailOauthRedirectUri() })
  if (!result.ok) return backToAgent(request, result.personId, result.message)

  revalidatePath('/organization')
  revalidatePath('/admin/settings')
  return backToAgent(request, result.personId)
}
