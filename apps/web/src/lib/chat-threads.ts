import 'server-only'
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm'
import type { RunInput, RunOutcome } from '@bunkhouse/runtime'
import { chatMessages, chatThreads, people, runEvents, runs, type RunTrigger } from '../db/schema'
import { db } from '../db/client'
import { replyTextForOutcome } from './chat-reply'
import { isPersonNotWorking } from './person-work'

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
  }): Promise<string>
  /** Appends under the thread's serialized seq allocator. */
  appendMessage(args: {
    tenantId: string
    threadId: string
    role: ChatMessageRole
    body: string
    runId?: string | null
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
}): ChatMessageView {
  return { id: row.id, seq: row.seq, role: row.role, body: row.body, at: row.at.toISOString(), runId: row.runId }
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
    async listThreads({ tenantId, userId, includeArchived, personId }) {
      const app = db()
      const rows = await app.withTenantContext(tenantId, () =>
        app.db
          .select({
            id: chatThreads.id,
            title: chatThreads.title,
            personId: chatThreads.personId,
            personName: people.name,
            status: chatThreads.status,
            userId: chatThreads.userId,
            lastMessageAt: chatThreads.lastMessageAt,
          })
          .from(chatThreads)
          .innerJoin(people, eq(people.id, chatThreads.personId))
          .where(
            and(
              eq(chatThreads.userId, userId),
              ...(includeArchived ? [] : [eq(chatThreads.status, 'open')]),
              ...(personId ? [eq(chatThreads.personId, personId)] : []),
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
    async createThread({ tenantId, userId, personId, title }) {
      const app = db()
      return app.withTenant(tenantId, async () => {
        const [row] = await app.db
          .insert(chatThreads)
          .values({ tenantId, userId, personId, title, createdBy: userId, updatedBy: userId })
          .returning({ id: chatThreads.id })
        if (!row) throw new Error('The conversation could not be started.')
        return row.id
      })
    },
    async appendMessage({ tenantId, threadId, role, body, runId }) {
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
          .values({ tenantId, threadId, seq: next, role, body, runId: runId ?? null })
          .returning({
            id: chatMessages.id,
            seq: chatMessages.seq,
            role: chatMessages.role,
            body: chatMessages.body,
            at: chatMessages.at,
            runId: chatMessages.runId,
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
  events(args: { tenantId: string; runId: string; afterSeq: number }): Promise<ChatRunEvent[]>
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
    async events({ tenantId, runId, afterSeq }) {
      const app = db()
      const rows = await app.withTenantContext(tenantId, () =>
        app.db
          .select({ seq: runEvents.seq, kind: runEvents.kind, payload: runEvents.payload })
          .from(runEvents)
          .where(and(eq(runEvents.runId, runId), sql`${runEvents.seq} > ${afterSeq}`))
          .orderBy(asc(runEvents.seq)),
      )
      return rows
    },
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
}) => Promise<{ runId: string; outcome: RunOutcome }>

export type ChatThreadDeps = {
  store?: ChatThreadStore
  run?: ChatRunner
  watcher?: ChatRunWatcher
  now?: () => Date
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
  args: { tenantId: string; userId: string; includeArchived?: boolean; personId?: string },
  deps: ChatThreadDeps = {},
): Promise<ChatThreadSummary[]> {
  return storeOf(deps).listThreads({
    tenantId: args.tenantId,
    userId: args.userId,
    includeArchived: args.includeArchived ?? false,
    ...(args.personId ? { personId: args.personId } : {}),
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
  await store.updateThread({
    tenantId: args.tenantId,
    threadId: args.threadId,
    updatedBy: args.userId,
    status: args.status,
  })
  return { status: args.status }
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

    // A double-submitted send must not run the agent twice. Serialization
    // orders the two calls; this is what stops the second one being work.
    const duplicate = findDoubleSubmit(history, body, now().getTime())
    if (duplicate) return { messages: duplicate }

    const asked = await store.appendMessage({
      tenantId: args.tenantId,
      threadId: args.threadId,
      role: 'user',
      body,
    })
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
        input: { type: 'chat', message: messageWithHistory(history, body) },
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

const WATCH_INTERVAL_MS = 700

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

  const drain = async (): Promise<void> => {
    if (!runId) {
      runId = await watcher.findRun({
        tenantId: args.tenantId,
        conversationId: args.conversationId,
        since: args.since,
      })
      if (!runId) return
      progress.onRun?.(runId)
    }
    const events = await watcher.events({ tenantId: args.tenantId, runId, afterSeq: cursor })
    for (const event of events) {
      cursor = Math.max(cursor, event.seq)
      if (event.kind === 'tool_call') {
        const toolName = String(event.payload.toolName ?? 'tool')
        const toolCallId = `${runId}:${event.seq}`
        pending.push({ toolCallId, toolName })
        progress.onToolCall?.({ toolCallId, toolName, input: event.payload.input })
      } else if (event.kind === 'tool_result') {
        // The ledger carries no call id, so a result pairs with the oldest
        // unanswered call of the same name — which is the order they finish in.
        const toolName = String(event.payload.toolName ?? 'tool')
        const index = pending.findIndex((call) => call.toolName === toolName)
        const matched = index === -1 ? pending.shift() : pending.splice(index, 1)[0]
        if (matched) progress.onToolResult?.({ toolCallId: matched.toolCallId, output: event.payload.output })
      }
    }
  }

  const loop = (async () => {
    while (!stopped) {
      await drain().catch(() => undefined)
      if (stopped) break
      await new Promise((resolve) => setTimeout(resolve, WATCH_INTERVAL_MS))
    }
    // One last pass, so the tools of a run that finished between polls are not
    // lost from the picture.
    await drain().catch(() => undefined)
  })()

  return {
    stop: async () => {
      stopped = true
      await loop
    },
  }
}
