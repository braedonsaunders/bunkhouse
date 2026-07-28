import { eq } from 'drizzle-orm'
import { avatarParts } from '../../../../db/schema'
import { db } from '../../../../db/client'
import { resolveTenantId } from '../../../../lib/tenant'

export const dynamic = 'force-dynamic'

/**
 * Serve one library part.
 *
 * This is the only avatar image endpoint. There is no per-person image to
 * serve: a person's figure is a composition of these parts, resolved in the
 * browser, so the same handful of part responses cache across the whole
 * directory instead of one bespoke image per person per size.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ partId: string }> }) {
  const { partId } = await params
  const tenantId = await resolveTenantId()
  const app = db()
  const row = await app.withTenantContext(tenantId, async () => {
    const [part] = await app.db
      .select({ contentType: avatarParts.contentType, data: avatarParts.data })
      .from(avatarParts)
      .where(eq(avatarParts.id, partId))
    return part
  })
  if (!row) return new Response('Not found', { status: 404 })
  return new Response(Buffer.from(row.data, 'base64'), {
    headers: {
      'Content-Type': row.contentType,
      // Parts are immutable once saved — a change is a new part with a new id.
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  })
}
