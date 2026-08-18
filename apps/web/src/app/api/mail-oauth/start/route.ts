import { requireUser } from '../../../../lib/auth'
import { resolveTenantId } from '../../../../lib/tenant'
import { beginMailOauth, isMailOauthProvider } from '../../../../lib/mail-oauth'
import { appUrl } from '../../../../lib/app-origin'

export const dynamic = 'force-dynamic'

/** Where the operator is sent back to, with an explanation when something fails. */
/**
 * Deliberately NOT built from `request.url`: inside a container that is the
 * address the server bound to, not the address the browser came from, so a
 * redirect built on it lands nowhere.
 */
async function backToAgent(personId: string, error?: string): Promise<Response> {
  const target = new URL(await appUrl(personId ? `/organization/${personId}` : '/organization'))
  if (personId) target.searchParams.set('section', 'mail')
  if (error) target.searchParams.set('mailboxError', error)
  return Response.redirect(target, 302)
}

/**
 * Start signing an agent's mailbox in with the company's Google Workspace or
 * Microsoft 365 application. Session and tenant are resolved here — the
 * consent URL carries a sealed state, so nothing about who is connecting what
 * is exposed to the browser or to the provider.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams
  const personId = params.get('personId') ?? ''
  const provider = params.get('provider') ?? ''

  await requireUser()
  const tenantId = await resolveTenantId('mail.manage')

  if (!personId) return await backToAgent('', 'Choose an agent before connecting a mailbox.')
  if (!isMailOauthProvider(provider)) {
    return await backToAgent(personId, 'That mail provider is not available.')
  }
  try {
    const { url } = await beginMailOauth({ tenantId, personId, provider })
    return Response.redirect(url, 302)
  } catch (error) {
    return await backToAgent(personId, error instanceof Error ? error.message : String(error))
  }
}
