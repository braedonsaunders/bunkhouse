import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The web chat surface, proved with the run engine, the desk runner and the
// database all faked out: a chat message is a RUN and never a parallel loop,
// the transcript is append-only, every desk action passes the feature gate and
// the autonomy dial before it touches a machine, and a takeover records its
// boundary and nothing whatsoever about what was typed (§3.14).

delete process.env.BUNKHOUSE_DESK_URL
delete process.env.BUNKHOUSE_DESK_TOKEN

import type { ChatRunner, ChatThreadStore, ChatThreadSummary } from '../src/lib/chat-threads'
import type { ChatDeskDeps } from '../src/lib/chat-desk'

const { conversationIdFor, listThreads, getThread, sendMessage, startThread, titleFromMessage } = await import(
  '../src/lib/chat-threads'
)

const { closeDesktop, deskStatus, openDesktop, parseDeskInput, sendDesktopInput, setTakeover } = await import(
  '../src/lib/chat-desk'
)

const { DEFAULT_DESK_POLICY } = await import('../src/lib/desk-policy')

const TENANT = '0194b8a2-3b74-7000-8000-000000000001'
const USER = '0194b8a2-3b74-7000-8000-0000000000b1'
const OTHER_USER = '0194b8a2-3b74-7000-8000-0000000000b2'
const AGENT = '0194b8a2-3b74-7000-8000-0000000000aa'

// ---------------------------------------------------------------------------
// A chat store in memory, with the ONE property the real one is required to
// have: a message, once appended, is never changed.
// ---------------------------------------------------------------------------

type StoredThread = {
  id: string
  tenantId: string
  userId: string
  personId: string
  title: string | null
  status: 'open' | 'closed'
  lastMessageAt: Date
}

type StoredMessage = {
  id: string
  threadId: string
  seq: number
  role: 'user' | 'agent' | 'system'
  body: string
  runId: string | null
  at: Date
}

function memoryChatStore(clock: () => Date) {
  const threads: StoredThread[] = []
  const messages: StoredMessage[] = []
  const store: ChatThreadStore = {
    async listThreads({ tenantId, userId }): Promise<ChatThreadSummary[]> {
      return threads
        .filter((thread) => thread.tenantId === tenantId && thread.userId === userId)
        .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime())
        .map((thread) => ({
          id: thread.id,
          title: thread.title ?? 'New conversation',
          personId: thread.personId,
          personName: 'Avery',
          status: thread.status,
          userId: thread.userId,
          lastMessageAt: thread.lastMessageAt.toISOString(),
        }))
    },
    async readThread({ threadId }) {
      const thread = threads.find((row) => row.id === threadId)
      if (!thread) return null
      return {
        id: thread.id,
        title: thread.title ?? 'New conversation',
        personId: thread.personId,
        personName: 'Avery',
        status: thread.status,
        userId: thread.userId,
      }
    },
    async readMessages({ threadId }) {
      return messages
        .filter((message) => message.threadId === threadId)
        .sort((a, b) => a.seq - b.seq)
        .map((message) => ({
          id: message.id,
          seq: message.seq,
          role: message.role,
          body: message.body,
          at: message.at.toISOString(),
          runId: message.runId,
        }))
    },
    async agentName({ personId }) {
      return personId === AGENT ? 'Avery' : null
    },
    async createThread({ tenantId, userId, personId, title }) {
      const id = `thread-${threads.length + 1}`
      threads.push({ id, tenantId, userId, personId, title, status: 'open', lastMessageAt: clock() })
      return id
    },
    async appendMessage({ threadId, role, body, runId }) {
      const seq = messages.filter((message) => message.threadId === threadId).length
      const row: StoredMessage = {
        id: `msg-${messages.length + 1}`,
        threadId,
        seq,
        role,
        body,
        runId: runId ?? null,
        at: clock(),
      }
      // Append-only, at the boundary the database also enforces with
      // reject_immutable_ledger_change: nothing here may ever rewrite a row.
      Object.freeze(row)
      messages.push(row)
      return { id: row.id, seq: row.seq, role: row.role, body: row.body, at: row.at.toISOString(), runId: row.runId }
    },
    async touchThread({ threadId, title, at }) {
      const thread = threads.find((row) => row.id === threadId)
      if (!thread) return
      thread.lastMessageAt = at
      if (title !== undefined) thread.title = title
    },
  }
  return { store, threads, messages }
}

/** A stand-in for `executeAgentRun` that records exactly how it was called. */
function fakeRunner(summary = 'Booked the appointment and emailed the confirmation.') {
  const calls: Parameters<ChatRunner>[0][] = []
  let n = 0
  const run: ChatRunner = async (args) => {
    calls.push(args)
    n += 1
    return {
      runId: `run-${n}`,
      outcome: {
        status: 'completed',
        summary,
        usage: { inputTokens: 10, outputTokens: 20 },
        messages: [],
      },
    }
  }
  return { run, calls }
}

// --- (a) a chat message IS a run, through executeAgentRun's own shapes ------
{
  const clock = () => new Date('2026-08-17T12:00:00.000Z')
  const { store, messages } = memoryChatStore(clock)
  const { run, calls } = fakeRunner()
  const deps = { store, run, now: clock }

  const { threadId } = await startThread(
    { tenantId: TENANT, userId: USER, personId: AGENT, firstMessage: 'Book the dentist for Thursday morning.' },
    deps,
  )
  assert.equal(calls.length, 0, 'opening a conversation is not itself work')

  const sent = await sendMessage(
    { tenantId: TENANT, threadId, userId: USER, body: 'Book the dentist for Thursday morning.' },
    deps,
  )

  assert.equal(calls.length, 1, 'exactly one run — one message, one governed unit of work')
  const call = calls[0]!
  assert.equal(call.tenantId, TENANT)
  assert.equal(call.personId, AGENT)
  assert.deepEqual(
    call.trigger,
    { type: 'chat', conversationId: conversationIdFor(threadId) },
    'the trigger is the bridge’s own `chat` shape — same governance, same ledger',
  )
  assert.equal(call.input.type, 'chat', 'and so is the input')
  assert.match(
    call.input.type === 'chat' ? call.input.message : '',
    /Book the dentist for Thursday morning\./,
  )

  assert.equal(sent.messages.length, 2, 'the turn is what was said and what came back')
  assert.equal(sent.messages[0]?.role, 'user')
  assert.equal(sent.messages[1]?.role, 'agent')
  assert.equal(sent.messages[1]?.body, 'Booked the appointment and emailed the confirmation.')
  assert.equal(sent.messages[1]?.runId, 'run-1', 'the reply carries the run it came from')
  assert.equal(messages.length, 2)

  const listed = await listThreads(TENANT, USER, deps)
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.title, 'Book the dentist for Thursday morning.', 'the list reads as topics')
  console.log('chat: a message becomes a run through executeAgentRun, with the bridge’s own trigger and input')
}

// --- (b) the transcript is append-only; a correction is a new message -------
{
  let tick = 0
  const clock = () => new Date(Date.parse('2026-08-17T12:00:00.000Z') + (tick += 60_000))
  const { store, messages } = memoryChatStore(clock)
  const { run } = fakeRunner()
  const deps = { store, run, now: clock }

  const { threadId } = await startThread({ tenantId: TENANT, userId: USER, personId: AGENT }, deps)
  await sendMessage({ tenantId: TENANT, threadId, userId: USER, body: 'Thursday morning, please.' }, deps)
  const before = (await getThread(TENANT, threadId, deps))!.messages.map((m) => ({ ...m }))

  await sendMessage({ tenantId: TENANT, threadId, userId: USER, body: 'Sorry — Friday morning, not Thursday.' }, deps)
  const after = (await getThread(TENANT, threadId, deps))!.messages

  assert.deepEqual(after.slice(0, before.length), before, 'nothing already said was edited')
  assert.equal(after.length, before.length + 2, 'the correction is a NEW message, plus its answer')
  assert.deepEqual(
    after.map((m) => m.seq),
    after.map((_, index) => index),
    'seq is dense and strictly increasing per thread',
  )
  assert.ok(
    messages.every((row) => Object.isFrozen(row)),
    'a recorded message is immutable once written',
  )

  // The database enforces the same thing, and that is not optional: check the
  // migration actually installs the ledger trigger and the tenant policy.
  const migration = readFileSync(
    fileURLToPath(new URL('../../../migrations/0056_chat_threads.sql', import.meta.url)),
    'utf8',
  )
  assert.match(
    migration,
    /CREATE TRIGGER chat_messages_immutable\s+BEFORE UPDATE OR DELETE ON chat_messages\s+FOR EACH ROW EXECUTE FUNCTION reject_immutable_ledger_change\(\);/,
    'chat_messages carries the immutable-ledger trigger',
  )
  for (const table of ['chat_threads', 'chat_messages']) {
    assert.match(migration, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`))
    assert.match(migration, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`))
    assert.match(migration, new RegExp(`CREATE POLICY tenant_isolation ON ${table}`))
  }
  console.log('chat: the transcript is append-only in the runtime and at the database boundary')
}

// --- (c) concurrency: one conversation, no double-run ----------------------
{
  const clock = () => new Date('2026-08-17T12:00:00.000Z')
  const { store } = memoryChatStore(clock)
  const { run, calls } = fakeRunner()
  const deps = { store, run, now: clock }
  const { threadId } = await startThread({ tenantId: TENANT, userId: USER, personId: AGENT }, deps)

  // Two sends racing on one thread — a double-clicked Send, or a retried
  // request. One turn of work, and the second call sees the same answer.
  const body = 'What did the supplier say?'
  const [first, second] = await Promise.all([
    sendMessage({ tenantId: TENANT, threadId, userId: USER, body }, deps),
    sendMessage({ tenantId: TENANT, threadId, userId: USER, body }, deps),
  ])
  assert.equal(calls.length, 1, 'a double submit runs the agent once')
  assert.deepEqual(second.messages, first.messages, 'and both callers are told the same thing')

  // A different message is genuinely a second turn.
  await sendMessage({ tenantId: TENANT, threadId, userId: USER, body: 'And the invoice?' }, deps)
  assert.equal(calls.length, 2)

  // Somebody else's conversation is not writable, whatever the tenant says.
  await assert.rejects(
    () => sendMessage({ tenantId: TENANT, threadId, userId: OTHER_USER, body: 'Hello?' }, deps),
    /belongs to someone else/,
  )
  assert.equal(calls.length, 2, 'and it started no run')
  console.log('chat: concurrent sends serialize, a double submit runs once, another user cannot post')
}

// --- titles -----------------------------------------------------------------
{
  assert.equal(titleFromMessage('  hello there \n second line'), 'hello there')
  assert.equal(titleFromMessage('\n\n'), null)
  assert.equal(titleFromMessage('x'.repeat(200))?.length, 72)
}

// ---------------------------------------------------------------------------
// The desk half
// ---------------------------------------------------------------------------

type StoreEvent = { sessionId: string; seq: number; kind: string; detail: Record<string, unknown> }

function memoryDeskStore() {
  const sessions: { id: string; runId: string; screenReason: string | null; status: string }[] = []
  const events: StoreEvent[] = []
  const store: NonNullable<ChatDeskDeps['store']> = {
    async openSession({ runId }) {
      const existing = sessions.find((session) => session.runId === runId)
      if (existing) {
        const seq = events.filter((e) => e.sessionId === existing.id).reduce((max, e) => Math.max(max, e.seq), 0)
        return { id: existing.id, seq }
      }
      const id = `session-${sessions.length + 1}`
      sessions.push({ id, runId, screenReason: null, status: 'active' })
      return { id, seq: 0 }
    },
    async appendEvent(args) {
      events.push({
        sessionId: args.sessionId,
        seq: args.seq,
        kind: args.kind,
        detail: args.detail as Record<string, unknown>,
      })
    },
    async markScreenOpened({ sessionId, reason }) {
      const session = sessions.find((row) => row.id === sessionId)
      if (session) session.screenReason = reason
    },
    async markSessionStatus({ sessionId, status }) {
      const session = sessions.find((row) => row.id === sessionId)
      if (session) session.status = status
    },
    async upsertJobStart() {},
    async markJobExit() {},
  }
  return { store, sessions, events }
}

function fakeDeskRunner() {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    calls.push({ method, path: url.pathname, ...(body ? { body } : {}) })
    if (/\/handover$/.test(url.pathname)) {
      return body?.op === 'end'
        ? Response.json({ ended: true })
        : Response.json({ url: 'https://desk.example/handover/abc', stream: `${url.pathname}/stream` })
    }
    return Response.json({ ok: true })
  }) as typeof fetch
  return { fetchImpl, calls }
}

const ACTOR = { name: 'Dana Wills' }

function deskDeps(
  overrides: {
    features?: { desk: boolean; desktop: boolean }
    level?: 'forbidden' | 'approval' | 'notify' | 'trusted'
    runId?: string | null
    screenRunning?: boolean
    handoverStartedAt?: Date | null
    noRunner?: boolean
  } = {},
) {
  const { store, sessions, events } = memoryDeskStore()
  const { fetchImpl, calls } = fakeDeskRunner()
  const deps: ChatDeskDeps = {
    ...(overrides.noRunner ? {} : { runner: { url: 'http://desk.internal', token: 'secret' } }),
    fetch: fetchImpl,
    store,
    isAgent: async () => true,
    policy: async () => DEFAULT_DESK_POLICY,
    features: async () => overrides.features ?? { desk: true, desktop: true },
    dial: async () => () => overrides.level ?? 'approval',
    resolveRunId: async () => (overrides.runId === undefined ? 'run-desk-1' : overrides.runId),
    screenRunning: async () => overrides.screenRunning ?? false,
    handoverStartedAt: async () => overrides.handoverStartedAt ?? null,
  }
  return { deps, store, sessions, events, calls }
}

// --- (d) the desk fails closed on every gate --------------------------------
{
  const noRunner = deskDeps({ noRunner: true })
  const withoutRunner = await openDesktop(
    { tenantId: TENANT, personId: AGENT, actor: ACTOR, reason: 'Vendor portal is GTK-only.' },
    noRunner.deps,
  )
  assert.ok('error' in withoutRunner, 'no runner: no machine, and no half-open door')
  assert.equal(noRunner.calls.length, 0)

  const parentOff = deskDeps({ features: { desk: false, desktop: false } })
  const refusedParent = await openDesktop(
    { tenantId: TENANT, personId: AGENT, actor: ACTOR, reason: 'Vendor portal is GTK-only.' },
    parentOff.deps,
  )
  assert.ok('error' in refusedParent && /turned off/.test(refusedParent.error))
  assert.equal(parentOff.calls.length, 0, 'the parent gate stops it before the runner is touched')

  const childOff = deskDeps({ features: { desk: true, desktop: false } })
  const refusedChild = await openDesktop(
    { tenantId: TENANT, personId: AGENT, actor: ACTOR, reason: 'Vendor portal is GTK-only.' },
    childOff.deps,
  )
  assert.ok('error' in refusedChild && /desktop screen is turned off/.test(refusedChild.error))
  assert.equal(childOff.calls.length, 0, 'the desktop feature gate is enforced on its own')

  const forbidden = deskDeps({ level: 'forbidden' })
  const refusedDial = await openDesktop(
    { tenantId: TENANT, personId: AGENT, actor: ACTOR, reason: 'Vendor portal is GTK-only.' },
    forbidden.deps,
  )
  assert.ok('error' in refusedDial && /forbidden/.test(refusedDial.error))
  assert.equal(forbidden.calls.length, 0, 'a human driving through the UI is still governed by the dial')
  assert.equal(forbidden.events.length, 0)

  // …and every other desk action, not just the one that opens a screen.
  const refusedInput = await sendDesktopInput(
    { tenantId: TENANT, personId: AGENT, actor: ACTOR, action: { action: 'click', x: 5, y: 5, button: 'left' } },
    deskDeps({ level: 'forbidden' }).deps,
  )
  assert.ok('error' in refusedInput)
  const refusedTakeover = await setTakeover(
    { tenantId: TENANT, personId: AGENT, actor: ACTOR, enabled: true },
    deskDeps({ level: 'forbidden' }).deps,
  )
  assert.ok('error' in refusedTakeover)
  const refusedClose = await closeDesktop(
    { tenantId: TENANT, personId: AGENT, actor: ACTOR },
    deskDeps({ features: { desk: true, desktop: false } }).deps,
  )
  assert.ok('error' in refusedClose)

  const noRun = deskDeps({ runId: null })
  const refusedNoRun = await openDesktop(
    { tenantId: TENANT, personId: AGENT, actor: ACTOR, reason: 'Vendor portal is GTK-only.' },
    noRun.deps,
  )
  assert.ok('error' in refusedNoRun, 'with no run there is nowhere to record it, so it is refused')
  assert.equal(noRun.calls.length, 0)

  const status = await deskStatus({ tenantId: TENANT, personId: AGENT }, deskDeps({ level: 'forbidden' }).deps)
  assert.deepEqual(
    { supported: status.supported, desk: status.desk, desktop: status.desktop, screenRunning: status.screenRunning },
    { supported: true, desk: true, desktop: false, screenRunning: false },
    'the page is told what it may offer',
  )
  assert.match(status.reason ?? '', /forbidden/, 'and why not, in words')
  console.log('chat desk: refused without a runner, behind either feature gate, and on a forbidden dial')
}

// --- (e) opening a screen is recorded, with or without prose ----------------
//
// The stated reason §3.17 asks for is the AGENT justifying an escalation to a
// reviewer — that requirement is `open_desktop`'s, and desk.test.mts (c) holds
// it. An operator opening their own agent's screen from the console has no
// reviewer to justify it to, so no prose is demanded of them; what may never
// weaken is the record of WHO opened it and that a hand did.
{
  // Its own run: one run has ONE desk session (§3.19), and the live session is
  // memoized by run id — two blocks sharing a run would share a session and
  // this one would write into the other's store.
  const byHand = deskDeps({ runId: 'run-desk-by-hand' })
  const openedByHand = await openDesktop({ tenantId: TENANT, personId: AGENT, actor: ACTOR }, byHand.deps)
  assert.deepEqual(openedByHand, { ok: true }, 'the console opens a screen without asking anyone to type a sentence')
  const handEvent = byHand.events.find((event) => event.kind === 'screen_open')
  assert.equal(handEvent?.detail.actor, 'Dana Wills', 'and the ledger still says who opened it')
  assert.match(
    String(handEvent?.detail.reason ?? ''),
    /Dana Wills/,
    'the recorded reason names the operator rather than being blank',
  )
  assert.match(
    byHand.sessions[0]?.screenReason ?? '',
    /Dana Wills/,
    'desk_sessions.screen_reason says a person opened it by hand',
  )

  const opened = deskDeps()
  const result = await openDesktop(
    { tenantId: TENANT, personId: AGENT, actor: ACTOR, reason: 'The vendor portal is a GTK app with no CLI.' },
    opened.deps,
  )
  assert.deepEqual(result, { ok: true })
  assert.ok(opened.calls.some((call) => /\/lease$/.test(call.path)), 'the desk was leased first')
  assert.ok(opened.calls.some((call) => /\/screen\/start$/.test(call.path)))
  assert.equal(
    opened.sessions[0]?.screenReason,
    'The vendor portal is a GTK app with no CLI.',
    'the reason lands on desk_sessions.screen_reason, exactly as open_desktop records it',
  )
  const screenOpen = opened.events.find((event) => event.kind === 'screen_open')
  assert.equal(screenOpen?.detail.reason, 'The vendor portal is a GTK app with no CLI.')
  assert.equal(screenOpen?.detail.actor, 'Dana Wills', 'and says who asked for it')
  console.log('chat desk: a screen the operator opens is recorded with its actor, and a stated reason is kept verbatim')
}

// --- (f) operator input is validated and recorded ---------------------------
{
  assert.equal(parseDeskInput({ action: 'click', x: 1.5, y: 2 }), null, 'a fractional pixel is not a pixel')
  assert.equal(parseDeskInput({ action: 'nope' }), null)
  assert.equal(parseDeskInput({ action: 'key', combo: '  ' }), null)
  assert.deepEqual(parseDeskInput({ action: 'click', x: 4, y: 9 }), { action: 'click', x: 4, y: 9, button: 'left' })

  const driving = deskDeps()
  const typed = await sendDesktopInput(
    { tenantId: TENANT, personId: AGENT, actor: ACTOR, action: { action: 'type', text: 'quarterly report' } },
    driving.deps,
  )
  assert.deepEqual(typed, { ok: true })
  const input = driving.calls.find((call) => /\/screen\/input$/.test(call.path))
  assert.equal(input?.body?.action, 'type')
  const event = driving.events.find((row) => row.kind === 'type')
  assert.equal(event?.detail.text, 'quarterly report', 'an operator step is evidence, like the agent’s own')
  assert.equal(event?.detail.actor, 'Dana Wills')
  console.log('chat desk: operator input is validated at the boundary and lands on the run’s ledger')
}

// --- (g) a takeover records its boundary and NOTHING that was typed ---------
{
  const begun = deskDeps({ screenRunning: true })
  const started = await setTakeover({ tenantId: TENANT, personId: AGENT, actor: ACTOR, enabled: true }, begun.deps)
  assert.deepEqual(
    { ok: 'ok' in started, active: 'active' in started ? started.active : null },
    { ok: true, active: true },
  )
  const handover = begun.calls.find((call) => /\/handover$/.test(call.path))
  assert.equal(handover?.body?.op, 'begin')
  assert.equal(handover?.body?.scope, 'control')
  assert.equal(handover?.body?.actor, 'Dana Wills')

  const beginEvent = begun.events.find((event) => event.kind === 'handover_begin')
  assert.ok(beginEvent, 'the boundary is on the ledger')
  assert.deepEqual(
    Object.keys(beginEvent!.detail).sort(),
    ['actor', 'scope'],
    'and carries the boundary ONLY — who, and at what scope',
  )

  const ended = deskDeps({
    screenRunning: true,
    handoverStartedAt: new Date(Date.now() - 90_000),
  })
  const stopped = await setTakeover({ tenantId: TENANT, personId: AGENT, actor: ACTOR, enabled: false }, ended.deps)
  assert.deepEqual(
    { ok: 'ok' in stopped, active: 'active' in stopped ? stopped.active : null },
    { ok: true, active: false },
  )
  assert.equal(ended.calls.find((call) => /\/handover$/.test(call.path))?.body?.op, 'end')
  const endEvent = ended.events.find((event) => event.kind === 'handover_end')
  assert.ok(endEvent, 'so is the end')
  assert.deepEqual(
    Object.keys(endEvent!.detail).sort(),
    ['actor', 'durationMs', 'scope'],
    'with how long it lasted, and still nothing about what happened during it',
  )
  assert.ok(Number(endEvent!.detail.durationMs) >= 89_000)

  // The masking is what makes a handover safe to use for a password or a
  // one-time code: no keystroke, key combo or coordinate may appear anywhere
  // in what a handover writes.
  const MASKED = ['text', 'combo', 'x', 'y', 'dx', 'dy', 'from', 'to', 'output', 'command']
  for (const event of [...begun.events, ...ended.events]) {
    if (!event.kind.startsWith('handover')) continue
    for (const field of MASKED) {
      assert.equal(field in event.detail, false, `handover events never carry ${field}`)
    }
  }
  assert.equal(
    [...begun.events, ...ended.events].filter((event) => ['click', 'type', 'key', 'scroll', 'drag'].includes(event.kind))
      .length,
    0,
    'a handover records no input events at all — the guest withholds them at the source',
  )
  console.log('chat desk: a takeover records begin and end with actor, scope and duration — and no keystrokes')
}

console.log(
  'chat: messages are runs, transcripts are append-only, desk actions are gated, handovers are masked',
)
