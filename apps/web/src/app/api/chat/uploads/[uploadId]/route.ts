import 'server-only'
import { requireTenantPermission } from '../../../../../lib/tenant'
import { MAX_CHAT_UPLOAD_BYTES, receiveChatFileUpload } from '../../../../../lib/files'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Same-origin upload receiver used by the shared AppKit FileUploader. */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ uploadId: string }> },
): Promise<Response> {
  const access = await requireTenantPermission('work.manage')
  const { uploadId } = await params
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uploadId)) {
    return problem('That upload identity is not valid.', 400)
  }
  const declaredLength = Number(request.headers.get('content-length') ?? '0')
  if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0 || declaredLength > MAX_CHAT_UPLOAD_BYTES) {
    return problem('Each attachment must be between 1 byte and 20 MB.', 413)
  }
  const contentType = request.headers.get('content-type') ?? 'application/octet-stream'
  try {
    const bytes = new Uint8Array(await request.arrayBuffer())
    if (bytes.byteLength > MAX_CHAT_UPLOAD_BYTES) return problem('Each attachment must be 20 MB or smaller.', 413)
    await receiveChatFileUpload({
      tenantId: access.tenantId,
      userId: access.user.id,
      uploadId,
      contentType,
      bytes,
    })
    return new Response(null, { status: 204 })
  } catch (reason) {
    return problem(reason instanceof Error ? reason.message : 'That file could not be uploaded.', 400)
  }
}

function problem(error: string, status: number): Response {
  return Response.json({ error }, { status })
}
