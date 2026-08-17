import { redirect } from 'next/navigation'
import { and, asc, eq } from 'drizzle-orm'
import { people } from '../../db/schema'
import { db } from '../../db/client'
import { requireTenantPermission } from '../../lib/tenant'
import { resolveAgentAiConfig } from '../../lib/ai'
import { listThreads } from '../../lib/chat-threads'

export const dynamic = 'force-dynamic'

/**
 * Chat now belongs to the employee record. Old links resolve the conversation
 * to its agent; the bare route opens the most recent conversation, then falls
 * back to the first active agent who can hold one.
 */
export default async function ChatRedirect({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string }>
}) {
  const { thread: requestedThreadId } = await searchParams
  const access = await requireTenantPermission('work.read')
  const allThreads = await listThreads({
    tenantId: access.tenantId,
    userId: access.user.id,
    includeArchived: true,
  })
  const requested = requestedThreadId
    ? allThreads.find((thread) => thread.id === requestedThreadId)
    : allThreads.find((thread) => thread.status === 'open') ?? allThreads[0]
  if (requested) {
    redirect(`/organization/${requested.personId}?section=chat&thread=${requested.id}`)
  }

  const app = db()
  const agents = await app.withTenantContext(access.tenantId, () =>
    app.db
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.kind, 'agent'), eq(people.status, 'active')))
      .orderBy(asc(people.name)),
  )
  for (const agent of agents) {
    if (await resolveAgentAiConfig(access.tenantId, agent.id)) {
      redirect(`/organization/${agent.id}?section=chat`)
    }
  }
  redirect('/organization')
}
