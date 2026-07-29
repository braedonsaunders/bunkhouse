import { requireUser } from '../../../../lib/auth'
import { resolveTenantId } from '../../../../lib/tenant'
import { beginMailOauth, isMailOauthProvider } from '../../../../lib/mail-oauth'

export const dynamic = 'force-dynamic'

/** Where the operator is sent back to, with an explanation when something fails. */
function backToAgent(request: Request, personId: string, error?: string): Response {
  const target = new URL('/organization', request.url)
  if (personId) target.searchParams.set('person', personId)
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
  const tenantId = await resolveTenantId()

  if (!personId) return backToAgent(request, '', 'Choose an agent before connecting a mailbox.')
  if (!isMailOauthProvider(provider)) {
    return backToAgent(request, personId, 'That mail provider is not available.')
  }
  try {
    const { url } = await beginMailOauth({ tenantId, personId, provider })
    return Response.redirect(url, 302)
  } catch (error) {
    return backToAgent(request, personId, error instanceof Error ? error.message : String(error))
  }
}
