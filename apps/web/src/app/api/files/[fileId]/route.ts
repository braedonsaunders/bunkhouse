import { getFileRecord, getFileStream } from '../../../../lib/files'
import { resolveTenantId } from '../../../../lib/tenant'

export const dynamic = 'force-dynamic'

/**
 * Download a ledgered file. Every download goes through here — auth + tenant
 * isolation via resolveTenantId — never straight to the bucket.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params
  const tenantId = await resolveTenantId('work.read')
  const record = await getFileRecord(tenantId, fileId)
  if (!record) return new Response('Not found', { status: 404 })
  const { stream, contentLength } = await getFileStream(record)
  return new Response(stream, {
    headers: {
      'Content-Type': record.contentType,
      'Content-Disposition': `attachment; filename="${record.filename.replaceAll('"', '')}"`,
      ...(contentLength ? { 'Content-Length': String(contentLength) } : {}),
      // Files are immutable once ledgered — a revision is a new file id.
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  })
}
