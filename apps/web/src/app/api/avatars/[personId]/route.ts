import { and, eq } from 'drizzle-orm'
import { avatarImages } from '../../../../db/schema'
import { db } from '../../../../db/client'
import { resolveTenantId } from '../../../../lib/tenant'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ personId: string }> }) {
  const { personId } = await params
  const kind = new URL(request.url).searchParams.get('kind') === 'full_body' ? 'full_body' : 'portrait'
  const tenantId = await resolveTenantId()
  const app = db()
  const row = await app.withTenantContext(tenantId, async () => {
    const [avatar] = await app.db
      .select()
      .from(avatarImages)
      .where(and(eq(avatarImages.personId, personId), eq(avatarImages.kind, kind)))
    return avatar
  })
  if (!row) return new Response('Not found', { status: 404 })
  return new Response(Buffer.from(row.data, 'base64'), {
    headers: {
      'Content-Type': row.contentType,
      'Cache-Control': 'private, max-age=300',
    },
  })
}
