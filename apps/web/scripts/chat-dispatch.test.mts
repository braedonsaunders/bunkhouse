import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type {
  ChatDispatchStore,
  ChatDispatchView,
} from '../src/lib/chat-dispatch'
import type {
  ChatMessageView,
  ChatRunner,
  ChatRunWatcher,
  ChatThreadStore,
} from '../src/lib/chat-threads'

const {
  dispatchChatMessage,
  drainChatDispatchQueue,
  enqueueChatMessage,
  retryChatDispatch,
} = await import('../src/lib/chat-dispatch')

const TENANT = '0194b8a2-3b74-7000-8000-000000000001'
const USER = '0194b8a2-3b74-7000-8000-0000000000b1'
const OTHER_USER = '0194b8a2-3b74-7000-8000-0000000000b2'
const AGENT = '0194b8a2-3b74-7000-8000-0000000000aa'
const THREAD = '0194b8a2-3b74-7000-8000-0000000000cc'

function memoryThreadStore(): { store: ChatThreadStore; messages: ChatMessageView[] } {
  const messages: ChatMessageView[] = []
  const store: ChatThreadStore = {
    async listThreads() {
      return [{
        id: THREAD,
        title: 'Dispatch laws',
        titled: true,
        personId: AGENT,
        personName: 'Avery',
        status: 'open',
        userId: USER,
        lastMessageAt: new Date(0).toISOString(),
      }]
    },
    async readThread({ threadId }) {
      return threadId === THREAD
        ? { id: THREAD, title: 'Dispatch laws', titled: true, personId: AGENT, personName: 'Avery', status: 'open', userId: USER }
        : null
    },
    async readMessages({ threadId }) {
      return threadId === THREAD ? messages.map((message) => ({ ...message })) : []
    },
    async agentName({ personId }) {
      return personId === AGENT ? 'Avery' : null
    },
    async createThread() {
      return THREAD
    },
    async appendMessage({ role, body, runId, dispatchId }) {
      const row: ChatMessageView = Object.freeze({
        id: `message-${messages.length}`,
        seq: messages.length,
        role,
        body,
        runId: runId ?? null,
        dispatchId: dispatchId ?? null,
        at: new Date(Date.parse('2026-08-18T12:00:00.000Z') + messages.length * 1_000).toISOString(),
      })
      messages.push(row)
      return { ...row }
    },
    async touchThread() {},
    async updateThread() {},
  }
  return { store, messages }
}

function memoryDispatchStore() {
  const rows: ChatDispatchView[] = []
  const keys = new Map<string, string>()
  const events: { dispatchId: string; kind: string; before?: string; after?: string }[] = []
  const copy = (row: ChatDispatchView): ChatDispatchView => ({ ...row })
  const required = (dispatchId: string): ChatDispatchView => {
    const row = rows.find((candidate) => candidate.id === dispatchId)
    if (!row) throw new Error('That queued message no longer exists.')
    return row
  }
  const store: ChatDispatchStore = {
    async read({ dispatchId }) {
      const row = rows.find((candidate) => candidate.id === dispatchId)
      return row ? copy(row) : null
    },
    async listPending({ threadId }) {
      return rows
        .filter((row) => row.threadId === threadId && ['queued', 'running', 'failed'].includes(row.status))
        .sort((a, b) => a.position - b.position)
        .map(copy)
    },
    async enqueue({ threadId, userId, body, idempotencyKey, attachmentIds = [] }) {
      const key = `${threadId}:${idempotencyKey}`
      const existingId = keys.get(key)
      if (existingId) return { dispatch: copy(required(existingId)), created: false }
      const row: ChatDispatchView = {
        id: `dispatch-${rows.length}`,
        threadId,
        userId,
        position: rows.filter((candidate) => candidate.threadId === threadId).length,
        body,
        status: 'queued',
        attempts: 0,
        runId: null,
        lastError: null,
        queuedAt: new Date().toISOString(),
        claimedAt: null,
        finishedAt: null,
        attachmentIds,
      }
      rows.push(row)
      keys.set(key, row.id)
      events.push({ dispatchId: row.id, kind: 'queued' })
      return { dispatch: copy(row), created: true }
    },
    async claimNext({ threadId }) {
      if (rows.some((row) => row.threadId === threadId && row.status === 'running')) return null
      const head = rows
        .filter((row) => row.threadId === threadId && (row.status === 'queued' || row.status === 'failed'))
        .sort((a, b) => a.position - b.position)[0]
      if (!head || head.status === 'failed') return null
      head.status = 'running'
      head.attempts += 1
      head.claimedAt = new Date().toISOString()
      events.push({ dispatchId: head.id, kind: 'claimed' })
      return copy(head)
    },
    async linkRun({ dispatchId, runId }) {
      const row = required(dispatchId)
      if (!row.runId) {
        row.runId = runId
        events.push({ dispatchId, kind: 'run_linked' })
      }
    },
    async settle({ dispatchId, status, runId, error }) {
      const row = required(dispatchId)
      if (row.status === status) return
      assert.equal(row.status, 'running')
      row.status = status
      row.runId = runId ?? row.runId
      row.lastError = status === 'failed' ? (error ?? 'failed') : null
      row.finishedAt = new Date().toISOString()
      events.push({ dispatchId, kind: status })
    },
    async retry({ dispatchId }) {
      const row = required(dispatchId)
      assert.equal(row.status, 'failed')
      row.status = 'queued'
      row.lastError = null
      row.finishedAt = null
      events.push({ dispatchId, kind: 'retried' })
      return copy(row)
    },
    async edit({ dispatchId, body }) {
      const row = required(dispatchId)
      assert.ok(row.status === 'queued' || row.status === 'failed')
      const before = row.body
      row.body = body
      events.push({ dispatchId, kind: 'edited', before, after: body })
      return copy(row)
    },
    async cancel({ dispatchId }) {
      const row = required(dispatchId)
      assert.ok(row.status === 'queued' || row.status === 'failed')
      row.status = 'cancelled'
      row.finishedAt = new Date().toISOString()
      events.push({ dispatchId, kind: 'cancelled' })
      return copy(row)
    },
    async pendingThreadIds() {
      return [...new Set(rows.filter((row) => row.status === 'queued' || row.status === 'running').map((row) => row.threadId))]
    },
    async running() {
      return rows.filter((row) => row.status === 'running').map(copy)
    },
  }
  return { store, rows, events }
}

const thread = memoryThreadStore()
const dispatch = memoryDispatchStore()
let failedOnce = false
let concurrent = 0
let maximumConcurrent = 0
let runNumber = 0
let lastRunAttachmentIds: string[] = []
const run: ChatRunner = async ({ input }) => {
  const body = input.type === 'chat' ? input.message : ''
  lastRunAttachmentIds = input.type === 'chat'
    ? (input.attachments ?? []).map((attachment) => attachment.fileId)
    : []
  concurrent += 1
  maximumConcurrent = Math.max(maximumConcurrent, concurrent)
  try {
    await new Promise((resolve) => setTimeout(resolve, 5))
    if (body.includes('second') && !failedOnce) {
      failedOnce = true
      throw new Error('The provider connection closed.')
    }
    runNumber += 1
    return {
      runId: `run-${runNumber}`,
      outcome: {
        status: 'completed',
        summary: `Finished ${body.includes('first') ? 'first' : body.includes('second') ? 'second' : 'third'}.`,
        usage: { inputTokens: 1, outputTokens: 1 },
        messages: [],
      },
    }
  } finally {
    concurrent -= 1
  }
}
const watcher: ChatRunWatcher = {
  async findRun() { return null },
  async events() { return [] },
}
const deps = {
  store: dispatch.store,
  chat: {
    store: thread.store,
    run,
    watcher,
    resolveAttachments: async ({ fileIds }: { fileIds: string[] }) => fileIds.map((fileId) => ({
      fileId,
      filename: 'forecast.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sizeBytes: 1_024,
    })),
  },
}

const first = await enqueueChatMessage({ tenantId: TENANT, threadId: THREAD, userId: USER, body: 'Do the first task.', idempotencyKey: 'one' }, deps)
const duplicate = await enqueueChatMessage({ tenantId: TENANT, threadId: THREAD, userId: USER, body: 'Do the first task.', idempotencyKey: 'one' }, deps)
assert.equal(duplicate.created, false)
assert.equal(duplicate.dispatch.id, first.dispatch.id, 'the same request identity returns the original queue row')

const second = await enqueueChatMessage({ tenantId: TENANT, threadId: THREAD, userId: USER, body: 'Do the second task.', idempotencyKey: 'two' }, deps)
await enqueueChatMessage({ tenantId: TENANT, threadId: THREAD, userId: USER, body: 'Do the third task.', idempotencyKey: 'three' }, deps)
assert.deepEqual(dispatch.rows.map((row) => row.position), [0, 1, 2], 'FIFO positions are stable and dense')

await Promise.all([
  drainChatDispatchQueue({ tenantId: TENANT, threadId: THREAD }, deps),
  drainChatDispatchQueue({ tenantId: TENANT, threadId: THREAD }, deps),
])
assert.equal(maximumConcurrent, 1, 'two drainers can never run two turns in one conversation')
assert.equal(dispatch.rows[0]?.status, 'completed')
assert.equal(dispatch.rows[1]?.status, 'failed')
assert.equal(dispatch.rows[2]?.status, 'queued', 'a failed head blocks everything behind it')
assert.deepEqual(
  thread.messages.filter((message) => message.role === 'user').map((message) => message.body),
  ['Do the first task.', 'Do the second task.'],
)

await retryChatDispatch({ tenantId: TENANT, dispatchId: second.dispatch.id, userId: USER }, deps)
await drainChatDispatchQueue({ tenantId: TENANT, threadId: THREAD }, deps)
assert.deepEqual(dispatch.rows.map((row) => row.status), ['completed', 'completed', 'completed'])
assert.equal(dispatch.rows[1]?.position, 1, 'retry preserves the original FIFO position')
assert.equal(dispatch.rows[1]?.attempts, 2)
assert.deepEqual(
  thread.messages.filter((message) => message.role === 'user').map((message) => message.body),
  ['Do the first task.', 'Do the second task.', 'Do the third task.'],
  'retry reuses the immutable user turn instead of appending it again',
)

await assert.rejects(
  () => enqueueChatMessage({ tenantId: TENANT, threadId: THREAD, userId: OTHER_USER, body: 'Intrude.', idempotencyKey: 'other' }, deps),
  /belongs to someone else/,
)

const direct = await dispatchChatMessage({
  tenantId: TENANT,
  threadId: THREAD,
  userId: USER,
  body: 'Do one more.',
  idempotencyKey: 'four',
}, deps)
assert.ok(direct.messages?.some((message) => message.role === 'agent'))

const attachmentId = '0194b8a2-3b74-7000-8000-0000000000f1'
await dispatchChatMessage({
  tenantId: TENANT,
  threadId: THREAD,
  userId: USER,
  body: 'Review the attached forecast.',
  idempotencyKey: 'five',
  attachmentIds: [attachmentId],
}, deps)
assert.deepEqual(lastRunAttachmentIds, [attachmentId], 'the claimed durable file set reaches the run input')
assert.deepEqual(dispatch.rows.at(-1)?.attachmentIds, [attachmentId], 'queue recovery retains the exact file set')
assert.deepEqual(
  dispatch.events.filter((event) => event.dispatchId === second.dispatch.id).map((event) => event.kind),
  ['queued', 'claimed', 'failed', 'retried', 'claimed', 'completed'],
  'the immutable event history explains the complete retry lifecycle',
)

const migration = readFileSync(fileURLToPath(new URL('../../../migrations/0063_chat_dispatch_queue.sql', import.meta.url)), 'utf8')
assert.match(migration, /CREATE UNIQUE INDEX "chat_dispatches_one_running_key"[\s\S]*WHERE "status" = 'running'/)
assert.match(migration, /CREATE TRIGGER chat_dispatches_state_machine/)
assert.match(migration, /CREATE TRIGGER chat_dispatch_events_immutable/)
for (const table of ['chat_dispatches', 'chat_dispatch_events']) {
  assert.match(migration, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`))
  assert.match(migration, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`))
  assert.match(migration, new RegExp(`CREATE POLICY tenant_isolation ON ${table}`))
}

const attachmentMigration = readFileSync(fileURLToPath(new URL('../../../migrations/0067_chat_file_attachments.sql', import.meta.url)), 'utf8')
assert.match(attachmentMigration, /CREATE TRIGGER chat_dispatch_attachments_immutable/)
assert.match(attachmentMigration, /CREATE TRIGGER chat_file_uploads_state_machine/)
for (const table of ['chat_file_uploads', 'chat_dispatch_attachments']) {
  assert.match(attachmentMigration, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`))
  assert.match(attachmentMigration, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`))
  assert.match(attachmentMigration, new RegExp(`CREATE POLICY tenant_isolation ON ${table}`))
}
const uploadHardeningMigration = readFileSync(fileURLToPath(new URL('../../../migrations/0068_chat_file_upload_hardening.sql', import.meta.url)), 'utf8')
assert.match(uploadHardeningMigration, /CREATE UNIQUE INDEX "chat_file_uploads_file_key"/)
assert.match(uploadHardeningMigration, /pending chat upload cannot claim a finalized file/)

console.log('chat dispatch: FIFO, one active run, failure barriers, idempotency, recovery, and immutable evidence')
