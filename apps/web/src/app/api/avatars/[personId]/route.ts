import { eq } from 'drizzle-orm'
import { avatarImages } from '../../../../db/schema'
import { db } from '../../../../db/client'
import { resolveTenantId } from '../../../../lib/tenant'

export const dynamic = 'force-dynamic'

export async function GET(_request: Request, { params }: { params: Promise<{ personId: string }> }) {
  const { personId } = await params
  const tenantId = await resolveTenantId()
  const app = db()
  const row = await app.withTenantContext(tenantId, async () => {
    const [avatar] = await app.db.select().from(avatarImages).where(eq(avatarImages.personId, personId))
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
