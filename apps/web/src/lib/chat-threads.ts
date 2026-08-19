import 'server-only'
import { and, asc, desc, eq, gte, or, sql } from 'drizzle-orm'
import { followDurableCursor } from '@braedonsaunders/appkit-events'
import type { ChatRequester, RunInput, RunOutcome } from '@bunkhouse/runtime'
import { chatMessages, chatThreads, people, runEvents, runs, type RunTrigger } from '../db/schema'
import { db } from '../db/client'
import { replyTextForOutcome } from './chat-reply'
import { isPersonNotWorking } from './person-work'
import { waitForRunEventWake } from './run-event-notifications'

/**
 * The in-app chat surface's runtime.
 *
 * Doctrine #1: mail is the primary surface and chat is secondary, so nothing
 * here is a parallel work system. A message a person sends becomes exactly the
 * governed run `executeAgentRun` already produces for an inbound email or a
 * Slack message — trigger `{ type: 'chat', conversationId }`, input
 * `{ type: 'chat', message }`, the same shapes lib/chat-bridge.ts uses — and
 * therefore the same autonomy dial, the same approvals, the same budget meter
 * and the same runs/run_events ledger. `chat_messages.run_id` is the join back
 * to the work; the thread is only the readable conversation on top of it.
 *
 * Everything a caller can reach is dependency-injectable (`ChatThreadDeps`),
 * exactly as `deskAbilities` is, so the behaviour above is provable without a
 * database or a model in the loop (scripts/chat.test.mts).
 */

// ---------------------------------------------------------------------------
// Views — the shapes the server actions and the API routes hand out. Times are
// ISO strings so they survive any transport (RSC payload, JSON, client state)
// without a Date/string ambiguity at the boundary.
// ---------------------------------------------------------------------------

export type ChatMessageRole = 'user' | 'agent' | 'system'

/** `open` is a live conversation; `closed` is one the reader has archived. */
export type ChatThreadStatus = 'open' | 'closed'

export type ChatMessageView = {
  id: string
  seq: number
  role: ChatMessageRole
  body: string
  at: string
  runId: string | null
  dispatchId: string | null
}

export type ChatThreadView = {
  id: string
  /** Always present to a reader. The column is nullable — a conversation can
   *  exist for the instant before its first message — but a blank row in a
   *  list is not a title, so the view resolves one. */
  title: string
  /**
   * Whether that title is the thread's own or only the placeholder above.
   *
   * This is what keeps a name someone chose: the first message's auto-title is
   * only ever written into a thread that has none, and `title` alone cannot
   * answer that question because the view has already resolved the null away.
   */
  titled: boolean
  personId: string
  personName: string
  status: ChatThreadStatus
  /** The human whose conversation this is. A thread is between one person and
   *  one agent; a colleague may not post into it. */
  userId: string
  /** The immutable branch point when this conversation continued from
   * another one. Null for an original conversation. */
  originThreadId: string | null
  originMessageSeq: number | null
}

export type ChatThreadSummary = ChatThreadView & { lastMessageAt: string }

// ---------------------------------------------------------------------------
// The store — every database touch, in one injectable place
// ---------------------------------------------------------------------------

export type ChatThreadStore = {
  /** `includeArchived` brings the closed conversations back into the answer;
   *  the default list is the live ones only. */
  listThreads(args: {
    tenantId: string
    userId: string
    includeArchived: boolean
    personId?: string
    query?: string
  }): Promise<ChatThreadSummary[]>
  readThread(args: { tenantId: string; threadId: string }): Promise<ChatThreadView | null>
  readMessages(args: { tenantId: string; threadId: string }): Promise<ChatMessageView[]>
  /** The agent's display name, or null when the person is not a live agent here. */
  agentName(args: { tenantId: string; personId: string }): Promise<string | null>
  createThread(args: {
    tenantId: string
    userId: string
    personId: string
    title: string | null
    originThreadId?: string | null
    originMessageSeq?: number | null
  }): Promise<string>
  /** Appends under the thread's serialized seq allocator. */
  appendMessage(args: {
    tenantId: string
    threadId: string
    role: ChatMessageRole
    body: string
    runId?: string | null
    dispatchId?: string | null
  }): Promise<ChatMessageView>
  touchThread(args: { tenantId: string; threadId: string; title?: string | null; at: Date }): Promise<void>
  /**
   * A deliberate change to the conversation record itself — its name, or
   * whether it is archived. Separate from `touchThread` because that one is the
   * conversation moving under its own weight and this one is a person's
   * decision: it stamps `updated_by` with the hand that made it, which is what
   * the audit columns are for.
   */
  updateThread(args: {
    tenantId: string
    threadId: string
    updatedBy: string
    title?: string
    status?: ChatThreadStatus
  }): Promise<void>
}

function messageView(row: {
  id: string
  seq: number
  role: ChatMessageRole
  body: string
  at: Date
  runId: string | null
  dispatchId: string | null
}): ChatMessageView {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    body: row.body,
    at: row.at.toISOString(),
    runId: row.runId,
    dispatchId: row.dispatchId,
  }
}

/**
 * The real store.
 *
 * `appendMessage` allocates `seq` the way `appendRunEvent` does rather than the
 * way an in-process counter would: a per-thread advisory lock inside the
 * thread's own transaction, then `max(seq) + 1` read under that lock. Two
 * server actions in two processes can genuinely post into one thread at the
 * same moment — a tab left open on a phone and one on a laptop — and a local
 * counter would have both choose the same number, losing the later row to the
 * unique index. `desk_events` serializes the same way for the same reason;
 * there it is one process per run, here it is not.
 */
export function dbChatThreadStore(): ChatThreadStore {
  return {
    async listThreads({ tenantId, userId, includeArchived, personId, query }) {
      const app = db()
      const search = query?.trim().toLocaleLowerCase() ?? ''
      const rows = await app.withTenantContext(tenantId, () =>
        app.db
          .select({
            id: chatThreads.id,
            title: chatThreads.title,
            personId: chatThreads.personId,
            personName: people.name,
            status: chatThreads.status,
            userId: chatThreads.userId,
            originThreadId: chatThreads.originThreadId,
            originMessageSeq: chatThreads.originMessageSeq,
            lastMessageAt: chatThreads.lastMessageAt,
          })
          .from(chatThreads)
          .innerJoin(people, eq(people.id, chatThreads.personId))
          .where(
            and(
              eq(chatThreads.userId, userId),
              ...(includeArchived ? [] : [eq(chatThreads.status, 'open')]),
              ...(personId ? [eq(chatThreads.personId, personId)] : []),
              ...(search
                ? [sql`(
                    position(${search} in lower(coalesce(${chatThreads.title}, ''))) > 0
                    or position(${search} in lower(${people.name})) > 0
                    or exists (
                      select 1 from ${chatMessages}
                      where ${chatMessages.threadId} = ${chatThreads.id}
                        and position(${search} in lower(${chatMessages.body})) > 0
                    )
                  )`]
                : []),
            ),
          )
          .orderBy(desc(chatThreads.lastMessageAt)),
      )
      return rows.map((row) => ({
        id: row.id,
        title: row.title ?? UNTITLED_THREAD,
        titled: row.title !== null,
        personId: row.personId,
        personName: row.personName,
        status: row.status,
        userId: row.userId,
        originThreadId: row.originThreadId,
        originMessageSeq: row.originMessageSeq,
        lastMessageAt: row.lastMessageAt.toISOString(),
      }))
    },
    async readThread({ tenantId, threadId }) {
      const app = db()
      const [row] = await app.withTenantContext(tenantId, () =>
        app.db
          .select({
            id: chatThreads.id,
            title: chatThreads.title,
            personId: chatThreads.personId,
            personName: people.name,
            status: chatThreads.status,
            userId: chatThreads.userId,
            originThreadId: chatThreads.originThreadId,
            originMessageSeq: chatThreads.originMessageSeq,
          })
          .from(chatThreads)
          .innerJoin(people, eq(people.id, chatThreads.personId))
          .where(eq(chatThreads.id, threadId))
          .limit(1),
      )
      return row ? { ...row, title: row.title ?? UNTITLED_THREAD, titled: row.title !== null } : null
    },
    async readMessages({ tenantId, threadId }) {
      const app = db()
      const rows = await app.withTenantContext(tenantId, () =>
        app.db
          .select({
            id: chatMessages.id,
            seq: chatMessages.seq,
            role: chatMessages.role,
            body: chatMessages.body,
            at: chatMessages.at,
            runId: chatMessages.runId,
            dispatchId: chatMessages.dispatchId,
          })
          .from(chatMessages)
          .where(eq(chatMessages.threadId, threadId))
          .orderBy(asc(chatMessages.seq)),
      )
      return rows.map(messageView)
    },
    async agentName({ tenantId, personId }) {
      const app = db()
      const [row] = await app.withTenantContext(tenantId, () =>
        app.db
          .select({ name: people.name })
          .from(people)
          .where(and(eq(people.id, personId), eq(people.kind, 'agent'), eq(people.status, 'active')))
          .limit(1),
      )
      return row?.name ?? null
    },
    async createThread({ tenantId, userId, personId, title, originThreadId, originMessageSeq }) {
      const app = db()
      return app.withTenant(tenantId, async () => {
        const [row] = await app.db
          .insert(chatThreads)
          .values({
            tenantId,
            userId,
            personId,
            title,
            originThreadId: originThreadId ?? null,
            originMessageSeq: originMessageSeq ?? null,
            createdBy: userId,
            updatedBy: userId,
          })
          .returning({ id: chatThreads.id })
        if (!row) throw new Error('The conversation could not be started.')
        return row.id
      })
    },
    async appendMessage({ tenantId, threadId, role, body, runId, dispatchId }) {
      const app = db()
      return app.withTenant(tenantId, async () => {
        await app.db.execute(
          sql`select pg_advisory_xact_lock(hashtext('bunkhouse.chat_messages'), hashtext(${threadId}))`,
        )
        const [{ next } = { next: 0 }] = await app.db
          .select({ next: sql<number>`coalesce(max(${chatMessages.seq}), -1) + 1`.mapWith(Number) })
          .from(chatMessages)
          .where(eq(chatMessages.threadId, threadId))
        const [row] = await app.db
          .insert(chatMessages)
          .values({ tenantId, threadId, seq: next, role, body, runId: runId ?? null, dispatchId: dispatchId ?? null })
          .returning({
            id: chatMessages.id,
            seq: chatMessages.seq,
            role: chatMessages.role,
            body: chatMessages.body,
            at: chatMessages.at,
            runId: chatMessages.runId,
            dispatchId: chatMessages.dispatchId,
          })
        if (!row) throw new Error('The message could not be recorded.')
        return messageView(row)
      })
    },
    async touchThread({ tenantId, threadId, title, at }) {
      const app = db()
      await app.withTenant(tenantId, async () => {
        await app.db
          .update(chatThreads)
          .set({ lastMessageAt: at, updatedAt: new Date(), ...(title === undefined ? {} : { title }) })
          .where(eq(chatThreads.id, threadId))
      })
    },
    async updateThread({ tenantId, threadId, updatedBy, title, status }) {
      const app = db()
      await app.withTenant(tenantId, async () => {
        await app.db
          .update(chatThreads)
          .set({
            ...(title === undefined ? {} : { title }),
            ...(status === undefined ? {} : { status }),
            updatedAt: new Date(),
            updatedBy,
          })
          .where(eq(chatThreads.id, threadId))
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Watching a run in flight — what makes the streaming route show tool cards
// ---------------------------------------------------------------------------

export type ChatRunEvent = { seq: number; kind: string; payload: Record<string, unknown> }

export type ChatRunWatcher = {
  /**
   * The run this turn started, found by the trigger's own conversation id.
   * `executeAgentRun` opens the row before the model does anything, so this is
   * how a caller learns the run id while the work is still running — it only
   * returns at the end.
   */
  findRun(args: { tenantId: string; conversationId: string; since: Date }): Promise<string | null>
  events(args: { tenantId: string; runId: string; afterSeq: number; limit?: number }): Promise<ChatRunEvent[]>
  waitForWake?: (args: { runId: string; signal: AbortSignal }) => Promise<void>
}

export function dbChatRunWatcher(): ChatRunWatcher {
  return {
    async findRun({ tenantId, conversationId, since }) {
      const app = db()
      const [row] = await app.withTenantContext(tenantId, () =>
        app.db
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              sql`${runs.trigger}->>'conversationId' = ${conversationId}`,
              gte(runs.startedAt, since),
            ),
          )
          .orderBy(desc(runs.startedAt))
          .limit(1),
      )
      return row?.id ?? null
    },
    async events({ tenantId, runId, afterSeq, limit }) {
      const app = db()
      const rows = await app.withTenantContext(tenantId, () => {
        const query = app.db
          .select({ seq: runEvents.seq, kind: runEvents.kind, payload: runEvents.payload })
          .from(runEvents)
          .where(and(eq(runEvents.runId, runId), sql`${runEvents.seq} > ${afterSeq}`))
          .orderBy(asc(runEvents.seq))
        return limit === undefined ? query : query.limit(limit)
      })
      return rows
    },
    waitForWake: ({ runId, signal }) => waitForRunEventWake(runId, signal),
  }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** The one door to the work. Injectable so tests prove a chat message really
 *  goes through it, and never through anything else. */
export type ChatRunner = (args: {
  tenantId: string
  personId: string
  trigger: RunTrigger
  input: RunInput
  progress?: {
    onTextDelta?: (delta: string) => void | Promise<void>
    onToolCall?: (call: { toolCallId: string; toolName: string; input: unknown }) => void | Promise<void>
    onToolResult?: (result: { toolCallId: string; output: unknown }) => void | Promise<void>
  }
}) => Promise<{ runId: string; outcome: RunOutcome }>

export type ChatThreadDeps = {
  store?: ChatThreadStore
  run?: ChatRunner
  watcher?: ChatRunWatcher
  now?: () => Date
  hasPendingDispatches?: (args: { tenantId: string; threadId: string }) => Promise<boolean>
  resolveRequester?: (args: {
    tenantId: string
    userId: string
    personId: string
    fallback?: ChatRequester
  }) => Promise<ChatRequester | undefined>
}

function storeOf(deps: ChatThreadDeps): ChatThreadStore {
  return deps.store ?? dbChatThreadStore()
}

async function runnerOf(deps: ChatThreadDeps): Promise<ChatRunner> {
  if (deps.run) return deps.run
  // Imported here rather than at module scope so the chat runtime can be
  // loaded — and tested — without dragging the whole run engine in behind it.
  const { executeAgentRun } = await import('./agent-runs')
  return (args) => executeAgentRun(args)
}

/**
 * Resolve the authenticated speaker against the company's people records.
 *
 * The browser may supply the signed-in operator's display name, but never its
 * own claim about hierarchy. Reporting-line standing is derived under tenant
 * RLS here. Tests with an injected store stay hermetic unless they explicitly
 * inject this resolver too.
 */
async function requesterOf(
  args: { tenantId: string; userId: string; personId: string; fallback?: ChatRequester },
  deps: ChatThreadDeps,
): Promise<ChatRequester | undefined> {
  if (deps.resolveRequester) return deps.resolveRequester(args)
  if (deps.store) return args.fallback

  const app = db()
  const resolved = await app.withTenantContext(args.tenantId, async () => {
    const identity = args.fallback?.email
      ? or(eq(people.userId, args.userId), sql`lower(${people.email}) = lower(${args.fallback.email})`)
      : eq(people.userId, args.userId)
    const [requester] = await app.db
      .select({ id: people.id, name: people.name, title: people.title })
      .from(people)
      .where(and(identity, eq(people.kind, 'human')))
      .limit(1)
    if (!requester) return undefined

    const [employee] = await app.db
      .select({ reportsToId: people.reportsToId })
      .from(people)
      .where(and(eq(people.id, args.personId), eq(people.kind, 'agent')))
      .limit(1)
    if (!employee) return undefined

    return {
      name: requester.name,
      title: requester.title,
      ...(args.fallback?.email ? { email: args.fallback.email } : {}),
      relationship: employee.reportsToId === requester.id ? 'manager' : 'colleague',
    } satisfies ChatRequester
  })
  return resolved ?? args.fallback
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The reader's own conversations, newest first.
 *
 * Archived ones are left out unless they are asked for: archiving is how a
 * finished conversation stops crowding the list, and a list that still showed
 * it would have achieved nothing. Nothing is destroyed by leaving it out — the
 * thread, its messages and the runs under them are all still there.
 */
export async function listThreads(
  args: { tenantId: string; userId: string; includeArchived?: boolean; personId?: string; query?: string },
  deps: ChatThreadDeps = {},
): Promise<ChatThreadSummary[]> {
  const query = args.query?.trim().slice(0, 200)
  return storeOf(deps).listThreads({
    tenantId: args.tenantId,
    userId: args.userId,
    includeArchived: args.includeArchived ?? false,
    ...(args.personId ? { personId: args.personId } : {}),
    ...(query ? { query } : {}),
  })
}

export async function getThread(
  tenantId: string,
  threadId: string,
  deps: ChatThreadDeps = {},
): Promise<{ thread: ChatThreadView; messages: ChatMessageView[] } | null> {
  const store = storeOf(deps)
  const thread = await store.readThread({ tenantId, threadId })
  if (!thread) return null
  return { thread, messages: await store.readMessages({ tenantId, threadId }) }
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

const TITLE_MAX = 72

/** What a conversation is called before anything has been said in it. */
export const UNTITLED_THREAD = 'New conversation'

/**
 * A thread's title is its opening line, tidied — so the list reads as a list of
 * topics rather than a column of timestamps. Derived once, into a thread that
 * has no title at all, and never again: re-deriving it because the third
 * message changed subject would make the list move under the reader, and it
 * would silently undo a name the reader had chosen for themselves.
 */
export function titleFromMessage(body: string): string | null {
  const first = body.trim().split('\n').find((line) => line.trim().length > 0)
  if (!first) return null
  const flat = first.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1).trimEnd()}…` : flat
}

/**
 * A name a person typed, made fit for a one-line list: whitespace collapsed
 * (a pasted paragraph is not a title), then held to the same length the
 * derived titles are held to. Over-length is refused rather than silently
 * clipped — quietly keeping something other than what was typed is the kind of
 * small lie that makes an operator distrust the whole surface.
 */
function cleanTitle(title: string): { title: string } | { error: string } {
  const flat = title.replace(/\s+/g, ' ').trim()
  if (!flat) return { error: 'Give the conversation a name.' }
  if (flat.length > TITLE_MAX) return { error: `A conversation name is at most ${TITLE_MAX} characters.` }
  return { title: flat }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** The trigger's conversation id — stable across a thread's whole life, the
 *  same way the bridge keys a Slack thread or a Teams conversation. */
export function conversationIdFor(threadId: string): string {
  return `web:${threadId}`
}

export async function startThread(
  args: { tenantId: string; userId: string; personId: string; firstMessage?: string },
  deps: ChatThreadDeps = {},
): Promise<{ threadId: string }> {
  const store = storeOf(deps)
  const name = await store.agentName({ tenantId: args.tenantId, personId: args.personId })
  if (!name) throw new Error('Pick an active agent to talk to.')
  const first = args.firstMessage?.trim() ?? ''
  const threadId = await store.createThread({
    tenantId: args.tenantId,
    userId: args.userId,
    personId: args.personId,
    title: first ? titleFromMessage(first) : null,
  })
  return { threadId }
}

/**
 * Continue from the latest recorded point in another conversation.
 *
 * This creates an independent conversation and records its branch point; it
 * does not copy or edit old messages. The first run in the child receives the
 * inherited context, while every new message and run is attributed to the
 * child's own id. That keeps both the user experience and the audit graph
 * honest about where the paths separated.
 */
export async function continueThread(
  args: { tenantId: string; userId: string; sourceThreadId: string },
  deps: ChatThreadDeps = {},
): Promise<{ threadId: string; originMessageSeq: number }> {
  const store = storeOf(deps)
  const source = await ownedThread(
    { tenantId: args.tenantId, threadId: args.sourceThreadId, userId: args.userId },
    store,
  )
  const name = await store.agentName({ tenantId: args.tenantId, personId: source.personId })
  if (!name) throw new Error('This agent is not available for a new conversation.')
  const messages = await store.readMessages({ tenantId: args.tenantId, threadId: source.id })
  const last = messages.at(-1)
  if (!last) throw new Error('Say something in this conversation before continuing it in a new one.')
  const prefix = 'Continuation of '
  const available = TITLE_MAX - prefix.length
  const sourceTitle = source.title.length > available
    ? `${source.title.slice(0, Math.max(1, available - 1)).trimEnd()}…`
    : source.title
  const threadId = await store.createThread({
    tenantId: args.tenantId,
    userId: args.userId,
    personId: source.personId,
    title: `${prefix}${sourceTitle}`,
    originThreadId: source.id,
    originMessageSeq: last.seq,
  })
  return { threadId, originMessageSeq: last.seq }
}

/**
 * The one gate on changing a conversation record.
 *
 * Tenant isolation is enforced underneath by RLS; this is the second half of
 * it, and it is the same rule `sendMessage` keeps. A colleague in the same
 * company may read a thread, but a thread is between one person and one agent —
 * they may not put words in it, and they may not rename or archive it either.
 * The sentence is deliberately identical to the one a refused post gets.
 */
async function ownedThread(
  args: { tenantId: string; threadId: string; userId: string },
  store: ChatThreadStore,
): Promise<ChatThreadView> {
  const thread = await store.readThread({ tenantId: args.tenantId, threadId: args.threadId })
  if (!thread) throw new Error('That conversation no longer exists.')
  if (thread.userId !== args.userId) throw new Error('That conversation belongs to someone else.')
  return thread
}

/**
 * Name a conversation by hand.
 *
 * Once named, it stays named: `sendMessage` only ever derives a title into a
 * thread that has none (`ChatThreadView.titled`), so the next message cannot
 * quietly rename this one back to whatever it happens to open with.
 */
export async function renameThread(
  args: { tenantId: string; threadId: string; userId: string; title: string },
  deps: ChatThreadDeps = {},
): Promise<{ title: string }> {
  const cleaned = cleanTitle(args.title)
  if ('error' in cleaned) throw new Error(cleaned.error)
  const store = storeOf(deps)
  await ownedThread(args, store)
  await store.updateThread({
    tenantId: args.tenantId,
    threadId: args.threadId,
    updatedBy: args.userId,
    title: cleaned.title,
  })
  return { title: cleaned.title }
}

/**
 * Archive a conversation, or bring it back.
 *
 * This is the only way a thread leaves the list, and it is deliberately not a
 * delete. A thread is a view onto runs — its messages carry the `run_id` of the
 * governed work they produced — so destroying it would orphan those references
 * and erase evidence, which is exactly what an append-only history forbids
 * (AGENTS.md). Closing it hides it and keeps every word.
 */
export async function setThreadStatus(
  args: { tenantId: string; threadId: string; userId: string; status: ChatThreadStatus },
  deps: ChatThreadDeps = {},
): Promise<{ status: ChatThreadStatus }> {
  const store = storeOf(deps)
  await ownedThread(args, store)
  if (args.status === 'closed') {
    const hasPending = deps.hasPendingDispatches
      ? await deps.hasPendingDispatches({ tenantId: args.tenantId, threadId: args.threadId })
      : deps.store
        ? false
        : (await import('./chat-dispatch')).listChatDispatches({
            tenantId: args.tenantId,
            threadId: args.threadId,
          }).then((dispatches) => dispatches.length > 0)
    if (hasPending) {
      throw new Error('Finish or remove the queued messages before archiving this conversation.')
    }
  }
  await store.updateThread({
    tenantId: args.tenantId,
    threadId: args.threadId,
    updatedBy: args.userId,
    status: args.status,
  })
  return { status: args.status }
}

/** The immutable lineage that precedes a continued conversation. */
async function inheritedHistory(
  args: { tenantId: string; thread: ChatThreadView },
  store: ChatThreadStore,
): Promise<ChatMessageView[]> {
  const generations: ChatMessageView[][] = []
  const seen = new Set<string>([args.thread.id])
  let child = args.thread

  // A practical corruption guard as well as a bound on legacy data. The
  // normal graph is acyclic because origin is fixed at creation time.
  for (let depth = 0; child.originThreadId && child.originMessageSeq !== null && depth < 16; depth += 1) {
    if (seen.has(child.originThreadId)) throw new Error('This conversation has an invalid continuation history.')
    seen.add(child.originThreadId)
    const parent = await store.readThread({ tenantId: args.tenantId, threadId: child.originThreadId })
    if (!parent || parent.userId !== child.userId || parent.personId !== child.personId) {
      throw new Error('This conversation’s earlier context is no longer available.')
    }
    const messages = await store.readMessages({ tenantId: args.tenantId, threadId: parent.id })
    generations.unshift(messages.filter((message) => message.seq <= child.originMessageSeq!))
    child = parent
  }
  if (child.originThreadId) throw new Error('This conversation’s continuation history is too deep to load safely.')
  return generations.flat()
}

/**
 * How long two identical consecutive sends are treated as one double-submit
 * rather than as somebody genuinely saying the same thing twice. Long enough
 * to cover a double-clicked Send and a retried request; far too short to
 * swallow a real repeat.
 */
const DOUBLE_SUBMIT_WINDOW_MS = 15_000

/**
 * Serializes turns within a thread, per process. Two sends racing on one
 * conversation must not interleave — a reply landing before the message it
 * answers is not a chat, it is a bug — and the seq allocator alone only
 * guarantees distinct numbers, not a sensible order.
 *
 * This is the desk's `LiveDesk.chain` for a conversation. Correctness across
 * processes comes from the advisory lock in the store; this is what makes one
 * process behave.
 */
type ChatChains = typeof globalThis & { __bunkhouseChatChains?: Map<string, Promise<unknown>> }
const chatRuntime = globalThis as ChatChains

function serializeByThread<T>(key: string, work: () => Promise<T>): Promise<T> {
  const chains = (chatRuntime.__bunkhouseChatChains ??= new Map())
  const previous = chains.get(key) ?? Promise.resolve()
  const next = previous.then(work, work)
  // The chain carries on after a failed turn: the failure surfaces to its own
  // caller and to nobody else. The tail is dropped once nothing is queued
  // behind it, so an idle process is not holding a map of every conversation
  // anybody has ever had.
  const tail = next.then(
    () => undefined,
    () => undefined,
  )
  chains.set(key, tail)
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key)
  })
  return next
}

/**
 * What a caller may watch while the turn is in flight. The non-streaming
 * server action passes nothing; the streaming route passes handlers and turns
 * them into UI message chunks. There is one implementation of a turn either
 * way — this is the only difference between them.
 */
export type ChatTurnProgress = {
  onRun?: (runId: string) => void
  onTextDelta?: (delta: string) => void
  onToolCall?: (call: { toolCallId: string; toolName: string; input: unknown }) => void
  onToolResult?: (result: { toolCallId: string; output: unknown }) => void
}

/** How much of the conversation rides into the run's instruction. */
const HISTORY_TURNS = 10
const HISTORY_CHARS = 6_000

/**
 * The message the agent is actually given: what was just said, with the recent
 * conversation above it when there is one.
 *
 * This is still exactly the bridge's `{ type: 'chat', message }` input — the
 * governed loop sees no new shape. It carries history because this surface,
 * unlike Slack or Teams, has no client of its own re-showing the thread to the
 * agent: without it the employee you are chatting with would answer every
 * message as though it were the first thing you had ever said to it.
 */
function messageWithHistory(prior: ChatMessageView[], body: string): string {
  const turns = prior
    .filter((message) => message.role !== 'system')
    .slice(-HISTORY_TURNS)
    .map((message) => `${message.role === 'user' ? 'Them' : 'You'}: ${message.body.trim()}`)
  if (turns.length === 0) return body
  let block = turns.join('\n\n')
  if (block.length > HISTORY_CHARS) block = `[…earlier messages trimmed]\n\n${block.slice(-HISTORY_CHARS)}`
  return `Earlier in this conversation:\n\n${block}\n\n---\n\nThey have just said:\n\n${body}`
}

/**
 * One turn of the conversation, end to end: record what the person said, do
 * the work as a governed run, record what the agent said back.
 *
 * The ONLY path a web chat message takes. The non-streaming server action and
 * the streaming API route both land here — the route passes `progress` and
 * renders what it is told; nothing about the work differs between them.
 */
export async function sendMessage(
  args: {
    tenantId: string
    threadId: string
    userId: string
    body: string
    /** Signed-in operator identity; hierarchy is re-derived from the database. */
    requester?: ChatRequester
    /** Durable queue identity. A retry reuses its already-recorded user turn. */
    dispatchId?: string
    progress?: ChatTurnProgress
  },
  deps: ChatThreadDeps = {},
): Promise<{ messages: ChatMessageView[] }> {
  const body = args.body.trim()
  if (!body) throw new Error('Write a message first.')
  const store = storeOf(deps)
  const now = deps.now ?? (() => new Date())

  return serializeByThread(`${args.tenantId}:${args.threadId}`, async () => {
    const thread = await store.readThread({ tenantId: args.tenantId, threadId: args.threadId })
    if (!thread) throw new Error('That conversation no longer exists.')
    // A conversation is between one person and one agent. Tenant isolation is
    // enforced by RLS underneath; this is the second half of it — a colleague
    // in the same company may read the record, but may not put words in
    // somebody else's conversation.
    if (thread.userId !== args.userId) throw new Error('That conversation belongs to someone else.')
    if (thread.status !== 'open') throw new Error('That conversation is closed.')

    const history = await store.readMessages({ tenantId: args.tenantId, threadId: args.threadId })
    const inherited = await inheritedHistory({ tenantId: args.tenantId, thread }, store)
    const requester = await requesterOf(
      {
        tenantId: args.tenantId,
        userId: args.userId,
        personId: thread.personId,
        ...(args.requester ? { fallback: args.requester } : {}),
      },
      deps,
    )

    // A dispatch retry must resume the one recorded question rather than put a
    // second copy into the immutable transcript. Ordinary direct sends retain
    // the short double-submit guard used by older callers.
    const recorded = args.dispatchId
      ? history.find((message) => message.dispatchId === args.dispatchId && message.role === 'user')
      : undefined
    if (!recorded) {
      const duplicate = args.dispatchId ? null : findDoubleSubmit(history, body, now().getTime())
      if (duplicate) return { messages: duplicate }
    }

    const asked = recorded ?? await store.appendMessage({
      tenantId: args.tenantId,
      threadId: args.threadId,
      role: 'user',
      body,
      ...(args.dispatchId ? { dispatchId: args.dispatchId } : {}),
    })
    if (!recorded) {
      await store.touchThread({
        tenantId: args.tenantId,
        threadId: args.threadId,
        at: new Date(asked.at),
        // `titled`, not `title`: the view always resolves a name to show, so the
        // title string is never empty and testing it would mean the first message
        // of a thread opened empty (the streaming path) never named it — and a
        // thread the reader had renamed would be at risk of being renamed back.
        ...(thread.titled ? {} : { title: titleFromMessage(body) }),
      })
    }

    const run = await runnerOf(deps)
    const conversationId = conversationIdFor(args.threadId)
    const watch = startWatching(
      {
        tenantId: args.tenantId,
        conversationId,
        since: new Date(asked.at),
        ...(args.progress ? { progress: args.progress } : {}),
      },
      deps,
    )

    let outcome: RunOutcome
    let runId: string
    try {
      const result = await run({
        tenantId: args.tenantId,
        personId: thread.personId,
        trigger: { type: 'chat', conversationId },
        input: {
          type: 'chat',
          message: messageWithHistory(
            [
              ...inherited,
              ...(recorded ? history.filter((message) => message.seq < recorded.seq) : history),
            ],
            body,
          ),
          ...(requester ? { requester } : {}),
        },
        ...(args.progress
          ? {
              progress: {
                ...(args.progress.onTextDelta ? { onTextDelta: args.progress.onTextDelta } : {}),
                ...(args.progress.onToolCall ? { onToolCall: args.progress.onToolCall } : {}),
                ...(args.progress.onToolResult ? { onToolResult: args.progress.onToolResult } : {}),
              },
            }
          : {}),
      })
      runId = result.runId
      outcome = result.outcome
    } catch (error) {
      // An employee who may not work still owes the person an answer, and this
      // conversation IS the record. The refusal is appended as a system note —
      // carrying the run the gate opened for it — rather than thrown away into
      // an error toast, so the thread says why it stopped instead of showing a
      // question nobody ever replied to.
      if (!isPersonNotWorking(error)) throw error
      const refused = await store.appendMessage({
        tenantId: args.tenantId,
        threadId: args.threadId,
        role: 'system',
        body: error.message,
        ...(error.runId ? { runId: error.runId } : {}),
        ...(args.dispatchId ? { dispatchId: args.dispatchId } : {}),
      })
      await store.touchThread({ tenantId: args.tenantId, threadId: args.threadId, at: new Date(refused.at) })
      return { messages: [asked, refused] }
    } finally {
      await watch.stop()
    }

    const answered = await store.appendMessage({
      tenantId: args.tenantId,
      threadId: args.threadId,
      role: 'agent',
      body: replyTextForOutcome(outcome),
      runId,
      ...(args.dispatchId ? { dispatchId: args.dispatchId } : {}),
    })
    await store.touchThread({ tenantId: args.tenantId, threadId: args.threadId, at: new Date(answered.at) })
    return { messages: [asked, answered] }
  })
}

/**
 * A repeat of the last thing said, inside the double-submit window, that has
 * already been answered. Returns the pair to hand back instead of running the
 * agent a second time on the same sentence.
 */
function findDoubleSubmit(history: ChatMessageView[], body: string, nowMs: number): ChatMessageView[] | null {
  for (let index = history.length - 1; index >= 0 && index >= history.length - 4; index -= 1) {
    const message = history[index]!
    if (message.role !== 'user') continue
    if (message.body !== body) return null
    if (nowMs - new Date(message.at).getTime() > DOUBLE_SUBMIT_WINDOW_MS) return null
    const answer = history.slice(index + 1).find((later) => later.role === 'agent')
    return answer ? [message, answer] : null
  }
  return null
}

// ---------------------------------------------------------------------------
// The in-flight watcher: run events → progress callbacks
// ---------------------------------------------------------------------------

const WATCH_INTERVAL_MS = 1_000

/**
 * Poll the run's own ledger while the work is happening and report tool calls
 * as they land. `run_events` is the record either way — this reads it, it does
 * not create a second stream of truth, and a turn whose watcher fails is still
 * a turn that completed.
 */
function startWatching(
  args: { tenantId: string; conversationId: string; since: Date; progress?: ChatTurnProgress },
  deps: ChatThreadDeps,
): { stop: () => Promise<void> } {
  const progress = args.progress
  if (!progress) return { stop: async () => {} }
  const watcher = deps.watcher ?? dbChatRunWatcher()
  let stopped = false
  let runId: string | null = null
  let cursor = -1
  const pending: { toolCallId: string; toolName: string }[] = []
  const controller = new AbortController()

  const findRun = async (): Promise<string | null> => {
    if (!runId) {
      runId = await watcher.findRun({
        tenantId: args.tenantId,
        conversationId: args.conversationId,
        since: args.since,
      })
      if (!runId) return null
      progress.onRun?.(runId)
    }
    return runId
  }

  const publish = (event: ChatRunEvent): void => {
      if (event.kind === 'tool_call') {
        const toolName = String(event.payload.toolName ?? 'tool')
        const toolCallId = typeof event.payload.toolCallId === 'string'
          ? event.payload.toolCallId
          : `${runId!}:${event.seq}`
        pending.push({ toolCallId, toolName })
        progress.onToolCall?.({ toolCallId, toolName, input: event.payload.input })
      } else if (event.kind === 'tool_result') {
        // The ledger carries no call id, so a result pairs with the oldest
        // unanswered call of the same name — which is the order they finish in.
        const toolName = String(event.payload.toolName ?? 'tool')
        const index = pending.findIndex((call) => call.toolName === toolName)
        const durableId = typeof event.payload.toolCallId === 'string' ? event.payload.toolCallId : null
        const durableIndex = durableId ? pending.findIndex((call) => call.toolCallId === durableId) : -1
        const matched = durableId
          ? (durableIndex === -1 ? { toolCallId: durableId, toolName } : pending.splice(durableIndex, 1)[0])
          : index === -1
            ? pending.shift()
            : pending.splice(index, 1)[0]
        if (matched) progress.onToolResult?.({ toolCallId: matched.toolCallId, output: event.payload.output })
      }
  }

  const loop = (async () => {
    while (!stopped && !controller.signal.aborted) {
      const found = await findRun().catch(() => null)
      if (!found) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer)
            controller.signal.removeEventListener('abort', finish)
            resolve()
          }
          const timer = setTimeout(finish, WATCH_INTERVAL_MS)
          controller.signal.addEventListener('abort', finish, { once: true })
        })
        continue
      }
      const source = {
        readAfter: async ({ cursor, limit }: { cursor: number | null; limit: number; signal: AbortSignal }) =>
          (await watcher.events({ tenantId: args.tenantId, runId: found, afterSeq: cursor ?? -1, limit }))
            .map((event) => ({ cursor: event.seq, event })),
        ...(watcher.waitForWake
          ? { waitForWake: ({ signal }: { cursor: number | null; signal: AbortSignal }) => watcher.waitForWake!({ runId: found, signal }) }
          : {}),
      }
      for await (const row of followDurableCursor({ source, cursor: -1, pollMs: WATCH_INTERVAL_MS, signal: controller.signal })) {
        cursor = Math.max(cursor, row.cursor)
        publish(row.event)
      }
      break
    }
  })()

  return {
    stop: async () => {
      stopped = true
      controller.abort()
      await loop
      // Push is only a wake-up hint. A run may commit its final rows just as
      // the caller asks this watcher to stop, so close with one authoritative
      // cursor read rather than trusting notification timing.
      const found = await findRun().catch(() => null)
      if (!found) return
      const tail = await watcher.events({ tenantId: args.tenantId, runId: found, afterSeq: cursor }).catch(() => [])
      for (const event of tail) {
        cursor = Math.max(cursor, event.seq)
        publish(event)
      }
    },
  }
}
