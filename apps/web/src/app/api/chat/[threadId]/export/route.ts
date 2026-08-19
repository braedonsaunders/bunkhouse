import 'server-only'
import { requireTenantPermission } from '../../../../../lib/tenant'
import { getThread } from '../../../../../lib/chat-threads'
import {
  chatExportFilename,
  chatExportJson,
  chatExportMarkdown,
  chatExportRecord,
} from '../../../../../lib/chat-export'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Download a tenant-scoped conversation as a readable transcript or its full portable record. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ threadId: string }> },
): Promise<Response> {
  const { threadId } = await params
  const access = await requireTenantPermission('work.read')
  const detail = await getThread(access.tenantId, threadId)
  // Conversation lists are personal. Do not turn a guessed thread id into a
  // way to export a colleague's private transcript.
  if (!detail || detail.thread.userId !== access.user.id) return new Response('Not found', { status: 404 })

  const format = new URL(request.url).searchParams.get('format') === 'json' ? 'json' : 'md'
  const record = chatExportRecord(detail.thread, detail.messages)
  const body = format === 'json' ? chatExportJson(record) : chatExportMarkdown(record)
  const filename = chatExportFilename(detail.thread.title, format)
  return new Response(body, {
    headers: {
      'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
