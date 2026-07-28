import { requireUser } from '../../../../lib/auth'
import { resolveTenantId } from '../../../../lib/tenant'
import { beginFilingOauth, isFilingOauthProvider } from '../../../../lib/filing'

export const dynamic = 'force-dynamic'

/** Back to Settings → Filing, carrying an explanation when something fails. */
function backToFiling(request: Request, error?: string): Response {
  const target = new URL('/admin/settings/filing', request.url)
  if (error) target.searchParams.set('filingError', error)
  return Response.redirect(target, 302)
}

/**
 * Start connecting the company's storage. Session and tenant are resolved
 * here; the consent URL carries a sealed state, so neither the browser nor the
 * provider learns which company is connecting what.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams
  const provider = params.get('provider') ?? ''
  const folderName = params.get('folder') ?? ''
  const driveId = params.get('driveId') ?? ''

  await requireUser()
  const tenantId = await resolveTenantId()

  if (!isFilingOauthProvider(provider)) {
    return backToFiling(request, 'That storage provider is not available.')
  }
  try {
    const { url } = await beginFilingOauth({
      tenantId,
      provider,
      folderName,
      ...(driveId ? { driveId } : {}),
    })
    return Response.redirect(url, 302)
  } catch (error) {
    return backToFiling(request, error instanceof Error ? error.message : String(error))
  }
}
