import type { ReactNode } from 'react'
import { and, asc, eq } from 'drizzle-orm'
import { people } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId } from '../../lib/tenant'
import { resolveAgentAiConfig } from '../../lib/ai'
import { listAvatarCompositions, loadAvatarPartLibrary } from '../../lib/avatars'
import { AVATAR_PART_CATEGORIES } from '../../lib/avatar-parts'
import { RosterAvatar } from '../../components/roster-avatar'
import {
  ChatWorkspace,
  type ChatAgentOption,
  type ChatThreadDetail,
} from '../../components/chat-workspace'
import { getThreadAction, listThreadsAction } from './actions'

export const dynamic = 'force-dynamic'

/**
 * Chat: the in-app way to reach an agent, beside the mailbox rather than
 * instead of it (doctrine #1 — mail is still the primary surface, and a chat
 * turn is a run on the same record either way).
 *
 * The page loads what is true at request time and hands it to the client
 * surface: the conversations, the agents who can hold one, their faces, and —
 * when the URL names a thread — that thread already open, so a shared link
 * lands on the conversation rather than on an empty pane.
 */
export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string }>
}) {
  const { thread: requestedThreadId } = await searchParams
  const tenantId = await resolveTenantId('work.read')
  const app = db()

  const roster = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ id: people.id, name: people.name, title: people.title })
      .from(people)
      .where(and(eq(people.kind, 'agent'), eq(people.status, 'active')))
      .orderBy(asc(people.name)),
  )

  // An agent with no model has nothing to think with, so it is not offered as
  // somebody to talk to — an option that can only fail is worse than one that
  // is not there (AGENTS.md: never a dead button).
  const thinkable = await Promise.all(
    roster.map(async (agent) => ((await resolveAgentAiConfig(tenantId, agent.id))?.modelSmart ? agent.id : null)),
  )
  const ready = new Set(thinkable.filter((id): id is string => id !== null))
  const agents: ChatAgentOption[] = roster.filter((agent) => ready.has(agent.id))

  const threads = await listThreadsAction()

  // Only a thread that is actually on this tenant's list is opened: a stale or
  // guessed id in the URL lands on the empty pane, not on an error page.
  const initialThread: ChatThreadDetail | null =
    requestedThreadId && threads.some((thread) => thread.id === requestedThreadId)
      ? await getThreadAction(requestedThreadId)
      : null

  // Faces are composed here and handed over as rendered nodes, the way the
  // observatory does it: the part library is a server-side asset and has no
  // business being shipped to a chat pane.
  const [compositions, partLibrary] = await Promise.all([
    listAvatarCompositions(tenantId),
    loadAvatarPartLibrary(tenantId),
  ])
  const avatars: Record<string, ReactNode> = {}
  for (const agent of roster) {
    avatars[agent.id] = (
      <RosterAvatar
        name={agent.name}
        composition={compositions.get(agent.id) ?? null}
        parts={partLibrary}
        categories={AVATAR_PART_CATEGORIES}
        size={26}
      />
    )
  }

  // Not PageContainer: chat is a fixed screen — the composer and the desk must
  // both stay reachable — so it takes the shell's canvas whole and scrolls
  // only where the columns stack.
  return (
    <ChatWorkspace threads={threads} agents={agents} avatars={avatars} initialThread={initialThread} />
  )
}
