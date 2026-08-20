import assert from 'node:assert/strict'
import type { ChatMessageView, ChatThreadStore, ChatThreadView } from '../src/lib/chat-threads'

// Scheduled work delivering into the conversation that asked for it, proved
// with an injected store: an agent may speak unprompted into its OWN thread and
// nowhere else, and a delivery address that no longer resolves is a fact the
// model can act on rather than an exception that fails a finished run.

const { postAgentMessage } = await import('../src/lib/chat-threads')

let failures = 0
async function check(what: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run()
    console.log(`  ok   ${what}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${what}`)
    console.log(`       ${error instanceof Error ? error.message : String(error)}`)
  }
}

const TENANT = 'tenant-1'
const AGENT = 'agent-1'
const THREAD = 'thread-1'

function storeWith(thread: ChatThreadView | null): {
  store: ChatThreadStore
  appended: ChatMessageView[]
  touched: { threadId: string; title?: string | null }[]
} {
  const appended: ChatMessageView[] = []
  const touched: { threadId: string; title?: string | null }[] = []
  const store = {
    async readThread() { return thread },
    async appendMessage(args) {
      const view: ChatMessageView = {
        id: `m${appended.length + 1}`,
        seq: appended.length + 1,
        role: args.role,
        body: args.body,
        at: new Date('2026-08-20T12:30:00Z').toISOString(),
        runId: args.runId ?? null,
        dispatchId: args.dispatchId ?? null,
      }
      appended.push(view)
      return view
    },
    async touchThread(args) {
      touched.push({ threadId: args.threadId, ...(args.title !== undefined ? { title: args.title } : {}) })
    },
    async listThreads() { return [] },
    async readMessages() { return [] },
    async agentName() { return 'Avery Morgan' },
    async createThread() { return THREAD },
    async appendApprovalContinuation() { throw new Error('not used') },
    async appendCredentialContinuation() { throw new Error('not used') },
    async updateThread() { /* not used */ },
  } as unknown as ChatThreadStore
  return { store, appended, touched }
}

const ownThread: ChatThreadView = {
  id: THREAD,
  title: 'Pre-open brief',
  titled: true,
  personId: AGENT,
  personName: 'Avery Morgan',
  status: 'open',
  userId: 'user-1',
  originThreadId: null,
  originMessageSeq: null,
}

console.log('posting into a conversation unprompted')

await check('an agent posts into its own thread and the thread rises', async () => {
  const { store, appended, touched } = storeWith(ownThread)
  const posted = await postAgentMessage(
    { tenantId: TENANT, threadId: THREAD, personId: AGENT, runId: 'run-1', body: '# Pre-open brief\n\nHere it is.' },
    { store },
  )
  assert.ok(posted)
  assert.equal(appended.length, 1)
  assert.equal(appended[0]!.role, 'agent')
  assert.equal(appended[0]!.runId, 'run-1')
  assert.match(appended[0]!.body, /Pre-open brief/)
  assert.equal(touched.length, 1)
  assert.equal(touched[0]!.threadId, THREAD)
})

await check('a scheduled delivery never renames the conversation', async () => {
  const { store, touched } = storeWith(ownThread)
  await postAgentMessage(
    { tenantId: TENANT, threadId: THREAD, personId: AGENT, runId: 'run-1', body: 'Totally different subject.' },
    { store },
  )
  // A standing deliverable arriving is not the conversation changing subject.
  assert.equal('title' in touched[0]!, false)
})

await check('an agent cannot post into a thread that belongs to another agent', async () => {
  const { store, appended } = storeWith({ ...ownThread, personId: 'someone-else' })
  const posted = await postAgentMessage(
    { tenantId: TENANT, threadId: THREAD, personId: AGENT, runId: 'run-1', body: 'Not mine to speak in.' },
    { store },
  )
  assert.equal(posted, null)
  assert.equal(appended.length, 0, 'nothing may be written into another agent’s conversation')
})

await check('a thread that no longer exists reports rather than throws', async () => {
  const { store, appended } = storeWith(null)
  const posted = await postAgentMessage(
    { tenantId: TENANT, threadId: THREAD, personId: AGENT, runId: 'run-1', body: 'Nowhere to go.' },
    { store },
  )
  assert.equal(posted, null)
  assert.equal(appended.length, 0)
})

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
