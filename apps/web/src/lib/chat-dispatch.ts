import 'server-only'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import {
  chatDispatchAttachments,
  chatDispatchEvents,
  chatDispatches,
  chatFileUploads,
  chatMessages,
  runs,
} from '../db/schema'
import { db, type BunkhouseDb } from '../db/client'
import { assertChatDispatchTransition, type ChatDispatchStatus } from './chat-dispatch-lifecycle'
import {
  getThread,
  sendMessage,
  type ChatMessageView,
  type ChatThreadDeps,
  type ChatTurnProgress,
} from './chat-threads'
import type { ChatRequester } from '@bunkhouse/runtime'

export type { ChatDispatchStatus } from './chat-dispatch-lifecycle'
export type ChatDispatchEventKind =
  | 'queued'
  | 'claimed'
  | 'run_linked'
  | 'completed'
  | 'failed'
  | 'retried'
  | 'edited'
  | 'cancelled'

export const MAX_CHAT_MESSAGE_CHARS = 32_000
const MAX_IDEMPOTENCY_KEY_CHARS = 128
export const MAX_CHAT_ATTACHMENTS = 8

export type ChatDispatchView = {
  id: string
  threadId: string
  userId: string
  position: number
  body: string
  status: ChatDispatchStatus
  attempts: number
  runId: string | null
  lastError: string | null
  queuedAt: string
  claimedAt: string | null
  finishedAt: string | null
  /** Exact immutable files carried by this turn. Present on a claimed row. */
  attachmentIds?: string[]
}

type TenantDatabase = BunkhouseDb['db']

type DispatchRow = {
  id: string
  threadId: string
  userId: string
  position: number
  body: string
  status: ChatDispatchStatus
  attempts: number
  runId: string | null
  lastError: string | null
  queuedAt: Date
  claimedAt: Date | null
  finishedAt: Date | null
}

function dispatchView(row: DispatchRow): ChatDispatchView {
  return {
    id: row.id,
    threadId: row.threadId,
    userId: row.userId,
    position: row.position,
    body: row.body,
    status: row.status,
    attempts: row.attempts,
    runId: row.runId,
    lastError: row.lastError,
    queuedAt: row.queuedAt.toISOString(),
    claimedAt: row.claimedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }
}

const dispatchSelection = {
  id: chatDispatches.id,
  threadId: chatDispatches.threadId,
  userId: chatDispatches.userId,
  position: chatDispatches.position,
  body: chatDispatches.body,
  status: chatDispatches.status,
  attempts: chatDispatches.attempts,
  runId: chatDispatches.runId,
  lastError: chatDispatches.lastError,
  queuedAt: chatDispatches.queuedAt,
  claimedAt: chatDispatches.claimedAt,
  finishedAt: chatDispatches.finishedAt,
} as const

async function appendEvent(
  database: TenantDatabase,
  args: {
    tenantId: string
    dispatchId: string
    kind: ChatDispatchEventKind
    detail?: Record<string, unknown>
    actorId?: string | null
  },
): Promise<void> {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtext('bunkhouse.chat_dispatch_event'), hashtext(${args.dispatchId}))`,
  )
  const [{ next } = { next: 0 }] = await database
    .select({ next: sql<number>`coalesce(max(${chatDispatchEvents.seq}), -1) + 1`.mapWith(Number) })
    .from(chatDispatchEvents)
    .where(eq(chatDispatchEvents.dispatchId, args.dispatchId))
  await database.insert(chatDispatchEvents).values({
    tenantId: args.tenantId,
    dispatchId: args.dispatchId,
    seq: next,
    kind: args.kind,
    detail: args.detail ?? {},
    actorId: args.actorId ?? null,
  })
}

export type ChatDispatchStore = {
  read(args: { tenantId: string; dispatchId: string }): Promise<ChatDispatchView | null>
  listPending(args: { tenantId: string; threadId: string }): Promise<ChatDispatchView[]>
  enqueue(args: {
    tenantId: string
    threadId: string
    userId: string
    body: string
    idempotencyKey: string
    attachmentIds?: string[]
  }): Promise<{ dispatch: ChatDispatchView; created: boolean }>
  claimNext(args: { tenantId: string; threadId: string }): Promise<ChatDispatchView | null>
  linkRun(args: { tenantId: string; dispatchId: string; runId: string }): Promise<void>
  settle(args: {
    tenantId: string
    dispatchId: string
    status: 'completed' | 'failed'
    runId?: string | null
    error?: string | null
  }): Promise<void>
  retry(args: { tenantId: string; dispatchId: string; actorId: string }): Promise<ChatDispatchView>
  edit(args: { tenantId: string; dispatchId: string; actorId: string; body: string }): Promise<ChatDispatchView>
  cancel(args: { tenantId: string; dispatchId: string; actorId: string }): Promise<ChatDispatchView>
  pendingThreadIds(args: { tenantId: string }): Promise<string[]>
  running(args: { tenantId: string }): Promise<ChatDispatchView[]>
}

async function attachmentIdsFor(database: TenantDatabase, dispatchId: string): Promise<string[]> {
  const rows = await database
    .select({ fileId: chatDispatchAttachments.fileId })
    .from(chatDispatchAttachments)
    .where(eq(chatDispatchAttachments.dispatchId, dispatchId))
    .orderBy(asc(chatDispatchAttachments.ordinal))
  return rows.map((row) => row.fileId)
}

/** PostgreSQL claim authority for the per-conversation FIFO queue. */
export function dbChatDispatchStore(): ChatDispatchStore {
  const app = db()
  return {
    async read({ tenantId, dispatchId }) {
      const [row] = await app.withTenantContext(tenantId, () =>
        app.db.select(dispatchSelection).from(chatDispatches).where(eq(chatDispatches.id, dispatchId)).limit(1),
      )
      return row ? dispatchView(row) : null
    },
    async listPending({ tenantId, threadId }) {
      const rows = await app.withTenantContext(tenantId, () =>
        app.db
          .select(dispatchSelection)
          .from(chatDispatches)
          .where(and(eq(chatDispatches.threadId, threadId), inArray(chatDispatches.status, ['queued', 'running', 'failed'])))
          .orderBy(asc(chatDispatches.position)),
      )
      return rows.map(dispatchView)
    },
    async enqueue({ tenantId, threadId, userId, body, idempotencyKey, attachmentIds = [] }) {
      return app.withTenant(tenantId, () =>
        app.db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as TenantDatabase
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext('bunkhouse.chat_dispatch'), hashtext(${threadId}))`,
          )
          const [existing] = await tx
            .select(dispatchSelection)
            .from(chatDispatches)
            .where(and(eq(chatDispatches.threadId, threadId), eq(chatDispatches.idempotencyKey, idempotencyKey)))
            .limit(1)
          if (existing) {
            const persistedIds = await attachmentIdsFor(tx, existing.id)
            if (persistedIds.join('\n') !== attachmentIds.join('\n')) {
              throw new Error('That message request identity was already used with different files.')
            }
            return { dispatch: { ...dispatchView(existing), attachmentIds: persistedIds }, created: false }
          }
          if (attachmentIds.length > 0) {
            const uploaded = await tx
              .select({ id: chatFileUploads.id, fileId: chatFileUploads.fileId })
              .from(chatFileUploads)
              .where(and(
                inArray(chatFileUploads.id, attachmentIds),
                eq(chatFileUploads.threadId, threadId),
                eq(chatFileUploads.userId, userId),
                eq(chatFileUploads.status, 'finalized'),
              ))
            const accepted = new Set(uploaded.filter((row) => row.fileId === row.id).map((row) => row.id))
            if (accepted.size !== attachmentIds.length || attachmentIds.some((id) => !accepted.has(id))) {
              throw new Error('One or more attached files are not available in this conversation.')
            }
          }
          const [{ next } = { next: 0 }] = await tx
            .select({ next: sql<number>`coalesce(max(${chatDispatches.position}), -1) + 1`.mapWith(Number) })
            .from(chatDispatches)
            .where(eq(chatDispatches.threadId, threadId))
          const [created] = await tx
            .insert(chatDispatches)
            .values({
              tenantId,
              threadId,
              userId,
              position: next,
              idempotencyKey,
              body,
              createdBy: userId,
              updatedBy: userId,
            })
            .returning(dispatchSelection)
          if (!created) throw new Error('The message could not be queued.')
          if (attachmentIds.length > 0) {
            await tx.insert(chatDispatchAttachments).values(
              attachmentIds.map((fileId, ordinal) => ({
                tenantId,
                dispatchId: created.id,
                fileId,
                ordinal,
                createdBy: userId,
              })),
            )
          }
          await appendEvent(tx, {
            tenantId,
            dispatchId: created.id,
            kind: 'queued',
            detail: { position: created.position, attachmentIds },
            actorId: userId,
          })
          return { dispatch: { ...dispatchView(created), attachmentIds }, created: true }
        }),
      )
    },
    async claimNext({ tenantId, threadId }) {
      return app.withTenant(tenantId, () =>
        app.db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as TenantDatabase
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext('bunkhouse.chat_dispatch'), hashtext(${threadId}))`,
          )
          const [active] = await tx
            .select({ id: chatDispatches.id })
            .from(chatDispatches)
            .where(and(eq(chatDispatches.threadId, threadId), eq(chatDispatches.status, 'running')))
            .limit(1)
          if (active) return null
          const [head] = await tx
            .select(dispatchSelection)
            .from(chatDispatches)
            .where(and(eq(chatDispatches.threadId, threadId), inArray(chatDispatches.status, ['queued', 'failed'])))
            .orderBy(asc(chatDispatches.position))
            .limit(1)
          // Failure is a deliberate queue barrier. Later work never skips it.
          if (!head || head.status === 'failed') return null
          assertChatDispatchTransition(head.status, 'running')
          const now = new Date()
          const [claimed] = await tx
            .update(chatDispatches)
            .set({
              status: 'running',
              attempts: sql`${chatDispatches.attempts} + 1`,
              claimedAt: now,
              finishedAt: null,
              lastError: null,
              updatedAt: now,
            })
            .where(and(eq(chatDispatches.id, head.id), eq(chatDispatches.status, 'queued')))
            .returning(dispatchSelection)
          if (!claimed) return null
          await appendEvent(tx, {
            tenantId,
            dispatchId: claimed.id,
            kind: 'claimed',
            detail: { attempt: claimed.attempts },
          })
          return { ...dispatchView(claimed), attachmentIds: await attachmentIdsFor(tx, claimed.id) }
        }),
      )
    },
    async linkRun({ tenantId, dispatchId, runId }) {
      await app.withTenant(tenantId, () =>
        app.db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as TenantDatabase
          const [current] = await tx
            .select({ status: chatDispatches.status, runId: chatDispatches.runId })
            .from(chatDispatches)
            .where(eq(chatDispatches.id, dispatchId))
            .limit(1)
          if (!current || current.status !== 'running' || current.runId === runId) return
          if (current.runId) throw new Error('That queued message is already linked to another run.')
          await tx.update(chatDispatches).set({ runId, updatedAt: new Date() }).where(eq(chatDispatches.id, dispatchId))
          await appendEvent(tx, { tenantId, dispatchId, kind: 'run_linked', detail: { runId } })
        }),
      )
    },
    async settle({ tenantId, dispatchId, status, runId, error }) {
      await app.withTenant(tenantId, () =>
        app.db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as TenantDatabase
          const [current] = await tx
            .select({ status: chatDispatches.status, runId: chatDispatches.runId })
            .from(chatDispatches)
            .where(eq(chatDispatches.id, dispatchId))
            .limit(1)
          if (!current || current.status === status) return
          assertChatDispatchTransition(current.status, status)
          const now = new Date()
          await tx
            .update(chatDispatches)
            .set({
              status,
              runId: runId ?? current.runId,
              lastError: status === 'failed' ? (error?.slice(0, 500) ?? 'The turn did not finish.') : null,
              finishedAt: now,
              updatedAt: now,
            })
            .where(eq(chatDispatches.id, dispatchId))
          await appendEvent(tx, {
            tenantId,
            dispatchId,
            kind: status,
            detail: status === 'failed' ? { error: error?.slice(0, 500) ?? 'The turn did not finish.' } : {},
          })
        }),
      )
    },
    async retry({ tenantId, dispatchId, actorId }) {
      return changeFailedOrQueued(app, {
        tenantId,
        dispatchId,
        actorId,
        action: 'retried',
      })
    },
    async edit({ tenantId, dispatchId, actorId, body }) {
      return changeFailedOrQueued(app, {
        tenantId,
        dispatchId,
        actorId,
        action: 'edited',
        body,
      })
    },
    async cancel({ tenantId, dispatchId, actorId }) {
      return changeFailedOrQueued(app, {
        tenantId,
        dispatchId,
        actorId,
        action: 'cancelled',
      })
    },
    async pendingThreadIds({ tenantId }) {
      const rows = await app.withTenantContext(tenantId, () =>
        app.db
          .selectDistinct({ threadId: chatDispatches.threadId })
          .from(chatDispatches)
          .where(inArray(chatDispatches.status, ['queued', 'running'])),
      )
      return rows.map((row) => row.threadId)
    },
    async running({ tenantId }) {
      const rows = await app.withTenantContext(tenantId, () =>
        app.db.select(dispatchSelection).from(chatDispatches).where(eq(chatDispatches.status, 'running')),
      )
      return rows.map(dispatchView)
    },
  }
}

async function changeFailedOrQueued(
  app: BunkhouseDb,
  args: {
    tenantId: string
    dispatchId: string
    actorId: string
    action: 'retried' | 'edited' | 'cancelled'
    body?: string
  },
): Promise<ChatDispatchView> {
  return app.withTenant(args.tenantId, () =>
    app.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as TenantDatabase
      const [current] = await tx
        .select(dispatchSelection)
        .from(chatDispatches)
        .where(eq(chatDispatches.id, args.dispatchId))
        .limit(1)
      if (!current) throw new Error('That queued message no longer exists.')
      if (args.action === 'retried' && current.status !== 'failed') {
        throw new Error('Only a failed queued message can be retried.')
      }
      if (args.action !== 'retried' && current.status !== 'queued' && current.status !== 'failed') {
        throw new Error('Only a waiting queued message can be changed.')
      }
      const now = new Date()
      const nextStatus = args.action === 'cancelled' ? 'cancelled' : args.action === 'retried' ? 'queued' : current.status
      if (nextStatus !== current.status) assertChatDispatchTransition(current.status, nextStatus)
      const [updated] = await tx
        .update(chatDispatches)
        .set({
          status: nextStatus,
          ...(args.body === undefined ? {} : { body: args.body }),
          ...(args.action === 'retried' ? { lastError: null, finishedAt: null } : {}),
          ...(args.action === 'cancelled' ? { finishedAt: now } : {}),
          updatedAt: now,
          updatedBy: args.actorId,
        })
        .where(eq(chatDispatches.id, args.dispatchId))
        .returning(dispatchSelection)
      if (!updated) throw new Error('That queued message could not be changed.')
      await appendEvent(tx, {
        tenantId: args.tenantId,
        dispatchId: args.dispatchId,
        kind: args.action,
        detail: args.action === 'edited' ? { before: current.body, after: args.body } : {},
        actorId: args.actorId,
      })
      return dispatchView(updated)
    }),
  )
}

export type ChatDispatchDeps = {
  store?: ChatDispatchStore
  chat?: ChatThreadDeps
}

function dispatchStoreOf(deps: ChatDispatchDeps): ChatDispatchStore {
  return deps.store ?? dbChatDispatchStore()
}

async function ownedOpenThread(
  args: { tenantId: string; threadId: string; userId: string },
  deps: ChatDispatchDeps,
): Promise<void> {
  const detail = await getThread(args.tenantId, args.threadId, deps.chat)
  if (!detail) throw new Error('That conversation no longer exists.')
  if (detail.thread.userId !== args.userId) throw new Error('That conversation belongs to someone else.')
  if (detail.thread.status !== 'open') throw new Error('That conversation is closed.')
}

export async function listChatDispatches(
  args: { tenantId: string; threadId: string },
  deps: ChatDispatchDeps = {},
): Promise<ChatDispatchView[]> {
  return dispatchStoreOf(deps).listPending(args)
}

export async function enqueueChatMessage(
  args: {
    tenantId: string
    threadId: string
    userId: string
    body: string
    idempotencyKey: string
    attachmentIds?: string[]
  },
  deps: ChatDispatchDeps = {},
): Promise<{ dispatch: ChatDispatchView; created: boolean }> {
  const body = args.body.trim()
  if (!body) throw new Error('Write a message first.')
  if (body.length > MAX_CHAT_MESSAGE_CHARS) throw new Error('That message is too long to send.')
  const idempotencyKey = args.idempotencyKey.trim()
  if (!idempotencyKey) throw new Error('That message needs a request identity.')
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARS) throw new Error('That message request identity is not valid.')
  const attachmentIds = [...new Set(args.attachmentIds ?? [])]
  if (attachmentIds.length !== (args.attachmentIds ?? []).length) throw new Error('The same file cannot be attached twice.')
  if (attachmentIds.length > MAX_CHAT_ATTACHMENTS) throw new Error(`Attach no more than ${MAX_CHAT_ATTACHMENTS} files to one message.`)
  if (attachmentIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
    throw new Error('One or more attachment identities are not valid.')
  }
  await ownedOpenThread(args, deps)
  return dispatchStoreOf(deps).enqueue({ ...args, body, idempotencyKey, attachmentIds })
}

export async function drainChatDispatchQueue(
  args: {
    tenantId: string
    threadId: string
    requester?: ChatRequester
    observeDispatchId?: string
    progress?: ChatTurnProgress
  },
  deps: ChatDispatchDeps = {},
): Promise<{ observedMessages: ChatMessageView[] | null }> {
  const store = dispatchStoreOf(deps)
  let observedMessages: ChatMessageView[] | null = null
  while (true) {
    const claimed = await store.claimNext({ tenantId: args.tenantId, threadId: args.threadId })
    if (!claimed) return { observedMessages }
    const observed = claimed.id === args.observeDispatchId
    try {
      const runLinks: Promise<void>[] = []
      const result = await sendMessage(
        {
          tenantId: args.tenantId,
          threadId: args.threadId,
          userId: claimed.userId,
          body: claimed.body,
          attachmentIds: claimed.attachmentIds ?? [],
          dispatchId: claimed.id,
          ...(args.requester ? { requester: args.requester } : {}),
          progress: {
            onRun: (runId) => {
              runLinks.push(store.linkRun({ tenantId: args.tenantId, dispatchId: claimed.id, runId }))
              if (observed) args.progress?.onRun?.(runId)
            },
            ...(observed && args.progress?.onTextDelta ? { onTextDelta: args.progress.onTextDelta } : {}),
            ...(observed && args.progress?.onToolCall ? { onToolCall: args.progress.onToolCall } : {}),
            ...(observed && args.progress?.onToolResult ? { onToolResult: args.progress.onToolResult } : {}),
          },
        },
        deps.chat,
      )
      await Promise.all(runLinks)
      const runId = result.messages.find((message) => message.runId)?.runId ?? claimed.runId
      await store.settle({
        tenantId: args.tenantId,
        dispatchId: claimed.id,
        status: 'completed',
        runId,
      })
      if (observed) observedMessages = result.messages
    } catch (error) {
      await store.settle({
        tenantId: args.tenantId,
        dispatchId: claimed.id,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
      // The failed head is a queue barrier; the operator chooses retry or
      // removal before anything behind it is allowed to start.
      return { observedMessages }
    }
  }
}

export async function dispatchChatMessage(
  args: {
    tenantId: string
    threadId: string
    userId: string
    body: string
    idempotencyKey: string
    attachmentIds?: string[]
    requester?: ChatRequester
    progress?: ChatTurnProgress
  },
  deps: ChatDispatchDeps = {},
): Promise<{ dispatch: ChatDispatchView; messages: ChatMessageView[] | null }> {
  const accepted = await enqueueChatMessage(args, deps)
  if (accepted.dispatch.status === 'completed') {
    const detail = await getThread(args.tenantId, args.threadId, deps.chat)
    return {
      dispatch: accepted.dispatch,
      messages: detail?.messages.filter((message) => message.dispatchId === accepted.dispatch.id) ?? [],
    }
  }
  const drained = await drainChatDispatchQueue(
    {
      tenantId: args.tenantId,
      threadId: args.threadId,
      ...(args.requester ? { requester: args.requester } : {}),
      observeDispatchId: accepted.dispatch.id,
      ...(args.progress ? { progress: args.progress } : {}),
    },
    deps,
  )
  return { dispatch: accepted.dispatch, messages: drained.observedMessages }
}

async function mutableOwnedDispatch(
  args: { tenantId: string; dispatchId: string; userId: string },
  deps: ChatDispatchDeps,
): Promise<ChatDispatchView> {
  const dispatch = await dispatchStoreOf(deps).read(args)
  if (!dispatch) throw new Error('That queued message no longer exists.')
  if (dispatch.userId !== args.userId) throw new Error('That queued message belongs to someone else.')
  await ownedOpenThread({ tenantId: args.tenantId, threadId: dispatch.threadId, userId: args.userId }, deps)
  return dispatch
}

export async function retryChatDispatch(
  args: { tenantId: string; dispatchId: string; userId: string },
  deps: ChatDispatchDeps = {},
): Promise<ChatDispatchView> {
  await mutableOwnedDispatch(args, deps)
  return dispatchStoreOf(deps).retry({ tenantId: args.tenantId, dispatchId: args.dispatchId, actorId: args.userId })
}

export async function editChatDispatch(
  args: { tenantId: string; dispatchId: string; userId: string; body: string },
  deps: ChatDispatchDeps = {},
): Promise<ChatDispatchView> {
  const body = args.body.trim()
  if (!body) throw new Error('Write a message first.')
  if (body.length > MAX_CHAT_MESSAGE_CHARS) throw new Error('That message is too long to send.')
  await mutableOwnedDispatch(args, deps)
  return dispatchStoreOf(deps).edit({
    tenantId: args.tenantId,
    dispatchId: args.dispatchId,
    actorId: args.userId,
    body,
  })
}

export async function cancelChatDispatch(
  args: { tenantId: string; dispatchId: string; userId: string },
  deps: ChatDispatchDeps = {},
): Promise<ChatDispatchView> {
  await mutableOwnedDispatch(args, deps)
  return dispatchStoreOf(deps).cancel({ tenantId: args.tenantId, dispatchId: args.dispatchId, actorId: args.userId })
}

export async function pendingChatThreadIds(
  tenantId: string,
  deps: ChatDispatchDeps = {},
): Promise<string[]> {
  return dispatchStoreOf(deps).pendingThreadIds({ tenantId })
}

/**
 * Reconcile a projection left running by a dead web process. The run ledger is
 * authoritative when linked. An unlinked claim gets a generous two-minute
 * window to open its run before it becomes a visible, retryable failure.
 */
export async function recoverChatDispatches(
  tenantId: string,
  deps: ChatDispatchDeps = {},
): Promise<{ completed: number; failed: number }> {
  const store = dispatchStoreOf(deps)
  const current = await store.running({ tenantId })
  let completed = 0
  let failed = 0
  for (const dispatch of current) {
    if (!dispatch.runId) {
      const claimedAt = dispatch.claimedAt ? new Date(dispatch.claimedAt).getTime() : 0
      if (Date.now() - claimedAt < 120_000) continue
      await store.settle({
        tenantId,
        dispatchId: dispatch.id,
        status: 'failed',
        error: 'The conversation process stopped before the run began.',
      })
      failed += 1
      continue
    }
    const app = db()
    const state = await app.withTenantContext(tenantId, async () => {
      const [run] = await app.db.select({ status: runs.status }).from(runs).where(eq(runs.id, dispatch.runId!)).limit(1)
      const [answer] = await app.db
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(and(eq(chatMessages.dispatchId, dispatch.id), eq(chatMessages.role, 'agent')))
        .limit(1)
      return { runStatus: run?.status ?? null, answered: Boolean(answer) }
    })
    if (state.answered) {
      await store.settle({ tenantId, dispatchId: dispatch.id, status: 'completed', runId: dispatch.runId })
      completed += 1
    } else if (
      state.runStatus !== 'running' &&
      state.runStatus !== 'waiting_approval' &&
      state.runStatus !== 'waiting_reply' &&
      state.runStatus !== 'waiting_credential'
    ) {
      await store.settle({
        tenantId,
        dispatchId: dispatch.id,
        status: 'failed',
        runId: dispatch.runId,
        error: 'The linked run ended before a conversation reply was recorded.',
      })
      failed += 1
    }
  }
  return { completed, failed }
}
