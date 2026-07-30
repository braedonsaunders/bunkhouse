import { requireUser } from '../../../../lib/auth'
import { resolveTenantId } from '../../../../lib/tenant'
import { beginFilingOauth, isFilingOauthProvider } from '../../../../lib/filing'
import { appUrl } from '../../../../lib/app-origin'

export const dynamic = 'force-dynamic'

/** Back to Settings → Filing, carrying an explanation when something fails. */
/**
 * Deliberately NOT built from `request.url`: inside a container that is the
 * address the server bound to, not the address the browser came from, so a
 * redirect built on it lands nowhere.
 */
async function backToFiling(error?: string): Promise<Response> {
  const target = new URL(await appUrl('/admin/settings/filing'))
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
    return await backToFiling('That storage provider is not available.')
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
    return await backToFiling(error instanceof Error ? error.message : String(error))
  }
}
