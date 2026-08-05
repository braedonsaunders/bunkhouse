import { revalidatePath } from 'next/cache'
import { completeMailOauth, mailOauthRedirectUri, mailOauthStatePerson } from '../../../../lib/mail-oauth'
import { appUrl } from '../../../../lib/app-origin'
import { syncPersonMailbox } from '../../../../lib/mailbox'

export const dynamic = 'force-dynamic'

/** How long the callback waits on the first fetch before handing back. */
const FIRST_SYNC_BUDGET_MS = 20_000

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

  // Fetch once before handing the operator back, so the mailbox they were just
  // told is connected is not an empty screen. The sweep that would otherwise
  // fill it runs every couple of minutes, and in the meantime a refresh cannot
  // help: nothing has been fetched yet, and nothing on the page says so.
  //
  // Bounded, because the first sync of a long-lived mailbox walks it from the
  // beginning and that is not something to hold a redirect open for. Whatever
  // is left when the clock runs out is picked up by the next sweep — messages
  // dedupe by Message-ID and the cursor only advances on a completed pass, so
  // an interrupted first sync costs repeated work and nothing else.
  await Promise.race([
    syncPersonMailbox(result.tenantId, result.personId).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, FIRST_SYNC_BUDGET_MS)),
  ])

  revalidatePath('/organization')
  revalidatePath('/admin/settings')
  return await backToAgent(result.personId)
}
