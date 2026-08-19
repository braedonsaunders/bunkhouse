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

import type {
  ChatRunner,
  ChatRunWatcher,
  ChatThreadDeps,
  ChatThreadStore,
  ChatThreadSummary,
} from '../src/lib/chat-threads'
import type { ChatDeskDeps } from '../src/lib/chat-desk'
import { PersonNotWorkingError } from '../src/lib/person-work'

const {
  conversationIdFor,
  listThreads,
  getThread,
  renameThread,
  sendMessage,
  setThreadStatus,
  startThread,
  continueThread,
  titleFromMessage,
} = await import('../src/lib/chat-threads')

const { chatExportFilename, chatExportJson, chatExportMarkdown, chatExportRecord } = await import('../src/lib/chat-export')

const {
  closeDesktop,
  deskVideo,
  deskStatus,
  openDesktop,
  parseDeskInput,
  sendDesktopInput,
  setDeskFrameRate,
  setTakeover,
} = await import('../src/lib/chat-desk')

const { AGENT_SCREEN_DRIVING_FPS, AGENT_SCREEN_WATCHING_FPS } = await import('../src/lib/agent-screen')

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
  updatedBy: string | null
  originThreadId: string | null
  originMessageSeq: number | null
}

type StoredMessage = {
  id: string
  threadId: string
  seq: number
  role: 'user' | 'agent' | 'system'
  body: string
  runId: string | null
  dispatchId: string | null
  at: Date
}

function memoryChatStore(clock: () => Date) {
  const threads: StoredThread[] = []
  const messages: StoredMessage[] = []
  const store: ChatThreadStore = {
    async listThreads({ tenantId, userId, includeArchived, personId, query }): Promise<ChatThreadSummary[]> {
      const search = query?.toLocaleLowerCase()
      return threads
        .filter((thread) => thread.tenantId === tenantId && thread.userId === userId)
        .filter((thread) => !personId || thread.personId === personId)
        .filter((thread) => includeArchived || thread.status === 'open')
        .filter((thread) => {
          if (!search) return true
          return (thread.title ?? 'New conversation').toLocaleLowerCase().includes(search)
            || messages.some((message) => message.threadId === thread.id && message.body.toLocaleLowerCase().includes(search))
        })
        .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime())
        .map((thread) => ({
          id: thread.id,
          title: thread.title ?? 'New conversation',
          titled: thread.title !== null,
          personId: thread.personId,
          personName: 'Avery',
          status: thread.status,
          userId: thread.userId,
          originThreadId: thread.originThreadId,
          originMessageSeq: thread.originMessageSeq,
          lastMessageAt: thread.lastMessageAt.toISOString(),
        }))
    },
    async readThread({ threadId }) {
      const thread = threads.find((row) => row.id === threadId)
      if (!thread) return null
      return {
        id: thread.id,
        title: thread.title ?? 'New conversation',
        titled: thread.title !== null,
        personId: thread.personId,
        personName: 'Avery',
        status: thread.status,
        userId: thread.userId,
        originThreadId: thread.originThreadId,
        originMessageSeq: thread.originMessageSeq,
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
          dispatchId: message.dispatchId,
        }))
    },
    async agentName({ personId }) {
      return personId === AGENT ? 'Avery' : null
    },
    async createThread({ tenantId, userId, personId, title, originThreadId, originMessageSeq }) {
      const id = `thread-${threads.length + 1}`
      threads.push({
        id,
        tenantId,
        userId,
        personId,
        title,
        status: 'open',
        lastMessageAt: clock(),
        updatedBy: userId,
        originThreadId: originThreadId ?? null,
        originMessageSeq: originMessageSeq ?? null,
      })
      return id
    },
    async appendMessage({ threadId, role, body, runId, dispatchId }) {
      const seq = messages.filter((message) => message.threadId === threadId).length
      const row: StoredMessage = {
        id: `msg-${messages.length + 1}`,
        threadId,
        seq,
        role,
        body,
        runId: runId ?? null,
        dispatchId: dispatchId ?? null,
        at: clock(),
      }
      // Append-only, at the boundary the database also enforces with
      // reject_immutable_ledger_change: nothing here may ever rewrite a row.
      Object.freeze(row)
      messages.push(row)
      return {
        id: row.id,
        seq: row.seq,
        role: row.role,
        body: row.body,
        at: row.at.toISOString(),
        runId: row.runId,
        dispatchId: row.dispatchId,
      }
    },
    async touchThread({ threadId, title, at }) {
      const thread = threads.find((row) => row.id === threadId)
      if (!thread) return
      thread.lastMessageAt = at
      if (title !== undefined) thread.title = title
    },
    async updateThread({ threadId, updatedBy, title, status }) {
      const thread = threads.find((row) => row.id === threadId)
      if (!thread) return
      if (title !== undefined) thread.title = title
      if (status !== undefined) thread.status = status
      thread.updatedBy = updatedBy
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
  const deps = {
    store,
    run,
    now: clock,
    resolveRequester: async ({ fallback }) => {
      assert.equal(fallback?.relationship, 'operator', 'the client only asserts authenticated operator standing')
      return {
        name: 'Jordan Lee',
        title: 'Owner',
        email: 'braedon@example.test',
        relationship: 'manager' as const,
      }
    },
  } satisfies ChatThreadDeps

  const { threadId } = await startThread(
    { tenantId: TENANT, userId: USER, personId: AGENT, firstMessage: 'Book the dentist for Thursday morning.' },
    deps,
  )
  assert.equal(calls.length, 0, 'opening a conversation is not itself work')

  const sent = await sendMessage(
    {
      tenantId: TENANT,
      threadId,
      userId: USER,
      body: 'Book the dentist for Thursday morning.',
      requester: { name: 'Jordan Lee', email: 'jordan@example.test', relationship: 'operator' },
    },
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
  assert.deepEqual(
    call.input.type === 'chat' ? call.input.requester : undefined,
    {
      name: 'Jordan Lee',
      title: 'Owner',
      email: 'braedon@example.test',
      relationship: 'manager',
    },
    'the trusted server resolves the signed-in speaker against the reporting line',
  )
  assert.match(
    call.input.type === 'chat' ? call.input.message : '',
    /Book the dentist for Thursday morning\./,
  )
  const { buildRunInstruction, buildSystemPrompt } = await import('@bunkhouse/runtime')
  assert.match(
    buildRunInstruction(call.input),
    /This person is your manager\. Treat their reasonable direct request as a priority/,
    'the employee sees managerial standing in the run instruction instead of inferring it from prose',
  )
  assert.match(buildRunInstruction(call.input), /only a tool result from this run can establish that/)
  assert.match(buildRunInstruction(call.input), /correct a prior refusal rather than defending it/)
  const system = buildSystemPrompt({
    agent: {
      id: AGENT,
      name: 'Marla',
      title: 'Cash Reporting Clerk',
      email: 'marla@example.test',
      personality: { bio: 'I report the cash position.', tone: ['warm'], signoff: 'Marla' },
      ai: { provider: 'openai', apiKey: 'test' },
      responsibilities: 'Prepare daily cash reporting.',
      reportsToId: 'manager-person',
      proactivity: 'duties',
    },
    company: {
      name: 'Example Company',
      directory: [
        {
          id: 'manager-person',
          kind: 'human',
          name: 'Jordan Lee',
          title: 'Owner',
          email: 'braedon@example.test',
        },
      ],
    },
    procedures: [],
    memories: [],
  })
  assert.match(system, /responsibilities describe your usual focus, not the outer limit/)
  assert.match(system, /reasonable direct requests carry managerial priority/)
  assert.match(system, /Never guess that autonomy, budget, review, cost, or a feature gate forbids an action/)
  assert.doesNotMatch(system, /when something exceeds your role/)

  assert.equal(sent.messages.length, 2, 'the turn is what was said and what came back')
  assert.equal(sent.messages[0]?.role, 'user')
  assert.equal(sent.messages[1]?.role, 'agent')
  assert.equal(sent.messages[1]?.body, 'Booked the appointment and emailed the confirmation.')
  assert.equal(sent.messages[1]?.runId, 'run-1', 'the reply carries the run it came from')
  assert.equal(messages.length, 2)

  const listed = await listThreads({ tenantId: TENANT, userId: USER }, deps)
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.title, 'Book the dentist for Thursday morning.', 'the list reads as topics')
  console.log('chat: a message becomes a run through executeAgentRun, with the bridge’s own trigger and input')
}

// --- (a2) run progress follows a durable cursor and push only wakes it ------
{
  const clock = () => new Date('2026-08-17T12:00:00.000Z')
  const { store } = memoryChatStore(clock)
  const ledger: Array<{ seq: number; kind: 'tool_call' | 'tool_result'; payload: Record<string, unknown> }> = []
  const emitted = [
    { seq: 0, kind: 'tool_call' as const, payload: { toolCallId: 'sdk-browser', toolName: 'browser_open', input: { url: 'https://example.test' } } },
    { seq: 1, kind: 'tool_result' as const, payload: { toolCallId: 'sdk-browser', toolName: 'browser_open', output: { opened: true } } },
  ]
  const tail = [
    { seq: 2, kind: 'tool_call' as const, payload: { toolCallId: 'sdk-save', toolName: 'save_file', input: { name: 'report.pdf' } } },
    { seq: 3, kind: 'tool_result' as const, payload: { toolCallId: 'sdk-save', toolName: 'save_file', output: { saved: true } } },
  ]
  let wake: (() => void) | null = null
  let listening: (() => void) | null = null
  const listeningReady = new Promise<void>((resolve) => {
    listening = resolve
  })
  const watcher: ChatRunWatcher = {
    findRun: async () => 'run-progress',
    events: async ({ afterSeq }) => ledger.filter((event) => event.seq > afterSeq),
    waitForWake: async ({ signal }) =>
      new Promise<void>((resolve) => {
        const finish = () => {
          signal.removeEventListener('abort', finish)
          resolve()
        }
        wake = finish
        listening?.()
        signal.addEventListener('abort', finish, { once: true })
      }),
  }
  const seen: string[] = []
  const run: ChatRunner = async (args) => {
    await args.progress?.onTextDelta?.('Opening the site…')
    await listeningReady
    ledger.push(...emitted)
    wake?.()
    await new Promise((resolve) => setTimeout(resolve, 20))
    // No wake for this tail: stopping the watcher must perform one final
    // authoritative cursor read rather than losing committed rows.
    ledger.push(...tail)
    return {
      runId: 'run-progress',
      outcome: { status: 'completed', summary: 'Opened the browser.', usage: { inputTokens: 1, outputTokens: 1 }, messages: [] },
    }
  }
  const deps = { store, run, watcher, now: clock }
  const { threadId } = await startThread({ tenantId: TENANT, userId: USER, personId: AGENT }, deps)
  await sendMessage(
    {
      tenantId: TENANT,
      threadId,
      userId: USER,
      body: 'Open the site.',
      progress: {
        onTextDelta: (delta) => seen.push(`text:${delta}`),
        onRun: (runId) => seen.push(`run:${runId}`),
        onToolCall: ({ toolCallId, toolName }) => seen.push(`call:${toolCallId}:${toolName}`),
        onToolResult: ({ toolCallId, output }) => seen.push(`result:${toolCallId}:${JSON.stringify(output)}`),
      },
    },
    deps,
  )
  assert.deepEqual(seen, [
    'text:Opening the site…',
    'run:run-progress',
    'call:sdk-browser:browser_open',
    'result:sdk-browser:{"opened":true}',
    'call:sdk-save:save_file',
    'result:sdk-save:{"saved":true}',
  ])
  console.log('chat: durable run events backfill by cursor and push wakes the follower')
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

// --- (b2) a completed streamed turn survives a profile-section switch ------
//
// AgentPanel keeps the rich live parts while it is mounted. The server tree
// behind it must still be refreshed after persistence catches up, otherwise
// leaving Chat and coming back remounts the panel from the pre-send snapshot;
// a hard browser refresh then appears to "recover" the missing answer.
{
  const workspace = readFileSync(
    fileURLToPath(new URL('../src/components/chat-workspace.tsx', import.meta.url)),
    'utf8',
  )
  const completion = workspace.slice(workspace.indexOf('void response'), workspace.indexOf('return response'))
  assert.ok(completion.includes('await refreshThread(threadId)'), 'the persisted turn is read after the stream closes')
  assert.ok(completion.includes('router.refresh()'), 'the backing server snapshot is refreshed before a later remount')
  assert.ok(
    completion.indexOf('await refreshThread(threadId)') < completion.indexOf('router.refresh()'),
    'the server tree is refreshed only after the durable transcript has caught up',
  )
  assert.ok(workspace.includes('headerActions={'), 'the work visibility control lives in AgentPanel’s main header')
  assert.equal(workspace.includes('Run records:'), false, 'internal run boundaries never accumulate above the transcript')
  assert.ok(workspace.includes('<ThreadNoticeBar'), 'only exceptional system notes occupy the transcript margin')
  assert.equal(
    workspace.includes('Separate conversations keep different pieces of work from bleeding into one another.'),
    false,
    'the redundant row above the chat no longer consumes vertical space',
  )
  assert.equal(workspace.includes('>Conversations</span>'), false, 'the thread pane header spends its space on actions, not a redundant label')
  assert.ok(
    workspace.includes("showArchived ? 'Hide archived' : 'Archived'") &&
      workspace.includes("variant={showArchived ? 'secondary' : 'ghost'}"),
    'the archived filter makes its active state and inverse action visible',
  )
  const archiveStatus = workspace.slice(
    workspace.indexOf('const setThreadStatus = React.useCallback'),
    workspace.indexOf('const conversation ='),
  )
  assert.ok(
    archiveStatus.includes("status === 'closed' && activeId === thread.id") &&
      archiveStatus.includes('setDetail(null)') &&
      archiveStatus.includes("url.searchParams.delete('thread')"),
    'archiving the selected conversation clears the middle pane and its URL instead of reloading the closed transcript',
  )
  const workSurface = readFileSync(
    fileURLToPath(new URL('../src/components/chat-work-surface.tsx', import.meta.url)),
    'utf8',
  )
  assert.ok(
    workSurface.includes("React.useState<'desktop' | 'browser' | 'terminal' | 'files' | 'remote' | 'history'>('desktop')"),
    'the persistent desktop is the default visual surface',
  )
  assert.ok(
    workSurface.indexOf("key: 'desktop'") < workSurface.indexOf("key: 'history'"),
    'History follows Desktop in the work-surface tabs',
  )
  assert.ok(
    workSurface.includes("surface.kind === 'browser'") && workSurface.includes('<BrowserWorkStage'),
    'a live browser has its own visual subtab instead of replacing the persistent desktop',
  )
  assert.ok(workSurface.includes('<RemoteComputerViewer'), 'an active customer computer has its own observable subtab')
  assert.ok(workSurface.includes('<TerminalSurface'), 'shell work has a graphical terminal surface instead of a text-only history row')
  assert.ok(
    workSurface.includes("surface.recentBrowser") && workSurface.includes("surface.recentTerminal"),
    'completed browser and terminal work remain reopenable after a turn or page reload',
  )
  for (const tab of ['desktop', 'browser', 'terminal', 'files', 'history']) {
    assert.ok(workSurface.includes(`key: '${tab}'`), `${tab} remains a stable tab even before it has content`)
  }
  assert.ok(workSurface.includes('<FilesWorkStage'), 'conversation files have a previewable work surface')
  assert.ok(
    workSurface.includes('role="tree"') && workSurface.includes('aria-label="Files in this conversation"') &&
      workSurface.includes("tabKey={selected?.id ?? 'file-tree'}") && workSurface.includes('aria-label="Back to files"'),
    'conversation files use a full-page tree that transitions to one full-page preview with a back control',
  )
  assert.equal(workSurface.includes('Conversation files</span>'), false, 'the file tree has no redundant title/count header')
  assert.ok(
    workSurface.includes('<ContextMenu') && workSurface.includes('useContextMenu()') && workSurface.includes('Download original'),
    'file rows use the native AppKit context menu and expose an actual download action',
  )
  assert.ok(
    workSurface.includes('AGENT_BROWSER_TRACK_NAME') && !workSurface.includes('trackName === AGENT_SCREEN_TRACK_NAME'),
    'the Browser tab subscribes only to the browser publication and cannot flicker to a desktop track',
  )
  const filePreviewRoute = readFileSync(
    fileURLToPath(new URL('../src/app/api/files/[fileId]/preview/route.ts', import.meta.url)),
    'utf8',
  )
  assert.ok(
    filePreviewRoute.includes('docxToPdf') && filePreviewRoute.includes('sofficeConvert') && filePreviewRoute.includes("'text/plain; charset=utf-8'"),
    'DOCX, Excel, Markdown and text previews pass through safe authenticated renderers',
  )
  assert.ok(
    workSurface.includes('surface.focus.key') && workSurface.includes('setActiveTab(surface.focus.tab)'),
    'each new observable work event selects its matching work tab, including repeated actions in one run',
  )
  assert.ok(workSurface.includes('surface.history.map'), 'the History tab renders conversation-wide durable steps')
  assert.ok(
    workSurface.includes('&run=${event.runId}&runTab=activity'),
    'a History step opens the work record flyout over the conversation instead of leaving Chat',
  )
  assert.ok(
    workSurface.includes('surface="browser"') && workSurface.includes('surface="terminal"'),
    'browser and terminal surfaces both expose fullscreen controls',
  )
  assert.ok(
    workSurface.includes('h-12 gap-0 overflow-x-hidden') &&
      workSurface.includes('[&>button]:!h-12') &&
      workSurface.includes('[&>button]:!flex-1'),
    'the stable work tabs divide a header matching the other panes instead of becoming a horizontal scroller',
  )
  const chatDesk = readFileSync(
    fileURLToPath(new URL('../src/components/chat-desk.tsx', import.meta.url)),
    'utf8',
  )
  assert.ok(
    chatDesk.includes('<WorkSurfaceFullscreenButton') && chatDesk.includes('surface="desktop"'),
    'desktop uses the same fullscreen affordance as browser and terminal',
  )
  assert.equal(chatDesk.includes('const header = ('), false, 'the Desktop tab does not repeat the agent name in a private header row')
  assert.ok(
    chatDesk.includes('title="Desktop ready"') && chatDesk.includes('title="Agent desks are off"'),
    'desktop ready and unavailable states use the same centered work-stage vocabulary',
  )
  const personRecord = readFileSync(
    fileURLToPath(new URL('../src/app/organization/person-record.tsx', import.meta.url)),
    'utf8',
  )
  assert.ok(personRecord.includes('await runDrawer({ tenantId, runId'), 'the employee page hosts the canonical run drawer')
  const employeeTabs = personRecord.slice(personRecord.indexOf('const pageSections'), personRecord.indexOf('const chatBaseParams'))
  assert.ok(
    employeeTabs.indexOf("key: 'overview'") < employeeTabs.indexOf("key: 'chat'") &&
      employeeTabs.indexOf("key: 'chat'") < employeeTabs.indexOf("key: 'mail'") &&
      employeeTabs.indexOf("key: 'mail'") < employeeTabs.indexOf("key: 'work'"),
    'the employee record orders Overview, Chat, Mail, then Work',
  )
  assert.equal(employeeTabs.includes("key: 'inbox'"), false, 'Mail is the canonical employee section name')
  const personSections = readFileSync(
    fileURLToPath(new URL('../src/app/organization/person-sections.tsx', import.meta.url)),
    'utf8',
  )
  assert.equal(personSections.includes("'Ready for work'"), false, 'the overview no longer carries the status hero')
  assert.equal(personSections.includes('`Next: ${nextDuty.title}`'), false, 'the overview does not repeat the next duty in a hero')
  assert.equal(workSurface.includes('is getting started'), false, 'a new run never blanks History with a placeholder')
  assert.ok(
    workspace.includes("{ key: 'chat', label: 'Chat'") && workspace.includes("{ key: 'call', label: 'Call'"),
    'the left-pane New menu owns both conversation modes',
  )
  assert.ok(
    workspace.includes('<Popover') && workspace.includes('align="start"') && workspace.includes('side="bottom"'),
    'the New menu is anchored directly below and left-aligned with its trigger',
  )
  assert.ok(
    workspace.includes('threads.length === 0 && canStart ? (') &&
      workspace.match(/<ConversationWelcome agent=\{agent\} avatar=\{callAvatar\} \/>/g)?.length === 2,
    'the animated welcome stage appears before a thread exists and inside a newly created empty thread',
  )
  assert.equal(
    workspace.includes('Start a conversation with ${agent.name}.'),
    false,
    'the pre-thread center pane no longer falls back to the old text-only empty state',
  )
  assert.equal(
    workspace.slice(workspace.indexOf('<AgentPanel'), workspace.indexOf('</AgentPanel>')).includes('onClick={() => void startCall()}'),
    false,
    'the center conversation header does not carry a separate Call button',
  )
  assert.ok(workspace.includes('<ConversationCall'), 'a call occupies the same center pane as text chat')
  console.log('chat: streamed turns survive section switches and one workspace holds chat, calls, and stable work tabs')
}

// --- (b3) every Call action enters the unified conversation workspace -------
{
  const { resolveCallAction } = await import('../src/lib/call-action')
  const action = resolveCallAction({ id: AGENT, kind: 'agent', status: 'active', voiceConfig: null })
  assert.equal(action?.href, `/organization/${AGENT}?section=chat&call=1`)
  assert.ok(action?.disabledReason, 'an unconfigured voice remains visibly unavailable')
  assert.equal(resolveCallAction({ id: USER, kind: 'human', status: 'active', voiceConfig: null }), null)
  const callActions = readFileSync(fileURLToPath(new URL('../src/app/call/actions.ts', import.meta.url)), 'utf8')
  assert.ok(
    callActions.includes("pg_advisory_xact_lock(hashtext('bunkhouse.chat_messages'), hashtext(${threadId}))"),
    'call transcripts append under the same per-thread sequence lock as text messages',
  )
  assert.ok(callActions.includes('.slice(copied?.count ?? 0)'), 'disconnect retries copy only uncopied call turns')
  console.log('chat: Call actions create a unified conversation instead of navigating to a call page')
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

// --- portable exports keep transcript and evidence joins --------------------
{
  const record = chatExportRecord(
    {
      id: 'thread-export',
      title: 'Dawson receivable / follow-up',
      personId: AGENT,
      personName: 'Avery',
      status: 'open',
      originThreadId: 'thread-source',
      originMessageSeq: 4,
    },
    [{
      id: 'message-export',
      seq: 0,
      role: 'agent',
      body: 'Drafted the follow-up.\r\nIt is ready for review.',
      at: '2026-08-17T12:00:00.000Z',
      runId: 'run-export',
      dispatchId: 'dispatch-export',
    }],
    '2026-08-17T13:00:00.000Z',
  )
  const markdown = chatExportMarkdown(record)
  assert.match(markdown, /^# Dawson receivable \/ follow-up/m)
  assert.match(markdown, /Continued from: thread-source through message 4/)
  assert.match(markdown, /Run run-export · Dispatch dispatch-export/)
  assert.match(markdown, /Drafted the follow-up\.\nIt is ready for review\./)
  assert.equal(JSON.parse(chatExportJson(record)).messages[0].runId, 'run-export')
  assert.equal(chatExportFilename('Dawson receivable / follow-up', 'md'), 'dawson-receivable-follow-up.md')
  assert.equal(chatExportFilename('!!!', 'json'), 'conversation.json')
  console.log('chat: Markdown and JSON exports preserve readable transcript and audit joins')
}

// --- (c2) a name someone chose outlives the next message --------------------
//
// The auto-title exists so the list reads as topics; it must never be the
// reason a conversation someone deliberately named goes back to being called
// after its opening line.
{
  let tick = 0
  const clock = () => new Date(Date.parse('2026-08-17T12:00:00.000Z') + (tick += 60_000))
  const { store, threads } = memoryChatStore(clock)
  const { run } = fakeRunner()
  const deps = { store, run, now: clock }

  // Opened empty — the streaming path — so the first message is what names it.
  const { threadId } = await startThread({ tenantId: TENANT, userId: USER, personId: AGENT }, deps)
  await sendMessage({ tenantId: TENANT, threadId, userId: USER, body: 'Chase the Kirby invoice.' }, deps)
  assert.equal(
    (await getThread(TENANT, threadId, deps))!.thread.title,
    'Chase the Kirby invoice.',
    'an unnamed thread takes its name from the first thing said in it',
  )

  const renamed = await renameThread(
    { tenantId: TENANT, threadId, userId: USER, title: '  Kirby   receivables \n ' },
    deps,
  )
  assert.equal(renamed.title, 'Kirby receivables', 'the name is trimmed and flattened to one line')
  assert.equal(threads[0]?.updatedBy, USER, 'and the audit column says whose hand did it')

  await sendMessage({ tenantId: TENANT, threadId, userId: USER, body: 'Actually, ring them instead.' }, deps)
  assert.equal(
    (await getThread(TENANT, threadId, deps))!.thread.title,
    'Kirby receivables',
    'the next message does NOT rename it back',
  )

  await assert.rejects(
    () => renameThread({ tenantId: TENANT, threadId, userId: USER, title: '   ' }, deps),
    /Give the conversation a name/,
  )
  await assert.rejects(
    () => renameThread({ tenantId: TENANT, threadId, userId: USER, title: 'x'.repeat(73) }, deps),
    /at most 72 characters/,
  )
  assert.equal((await getThread(TENANT, threadId, deps))!.thread.title, 'Kirby receivables', 'and neither stuck')
  console.log('chat: a manual name sticks, is tidied, and is never overwritten by a later message')
}

// --- (c3) archiving hides a conversation; nothing deletes one ----------------
{
  const clock = () => new Date('2026-08-17T12:00:00.000Z')
  const { store, messages } = memoryChatStore(clock)
  const { run } = fakeRunner()
  const deps = { store, run, now: clock }

  const { threadId } = await startThread(
    { tenantId: TENANT, userId: USER, personId: AGENT, firstMessage: 'Reconcile the float.' },
    deps,
  )
  await sendMessage({ tenantId: TENANT, threadId, userId: USER, body: 'Reconcile the float.' }, deps)
  const before = messages.length

  await setThreadStatus({ tenantId: TENANT, threadId, userId: USER, status: 'closed' }, deps)
  assert.deepEqual(
    await listThreads({ tenantId: TENANT, userId: USER }, deps),
    [],
    'an archived conversation is out of the default list',
  )
  const archived = await listThreads({ tenantId: TENANT, userId: USER, includeArchived: true }, deps)
  assert.equal(archived.length, 1, 'and back in it when they are asked for')
  assert.equal(archived[0]?.status, 'closed')
  assert.deepEqual(
    await listThreads({ tenantId: TENANT, userId: USER, includeArchived: true, personId: OTHER_USER }, deps),
    [],
    'an agent profile never lists another agent’s conversations',
  )

  // Hidden, never destroyed: the transcript and the run ids under it are the
  // whole reason this is an archive and not a delete.
  assert.equal(messages.length, before, 'archiving wrote nothing to the transcript and removed nothing')
  const stillThere = await getThread(TENANT, threadId, deps)
  assert.equal(stillThere?.messages.length, before, 'and the conversation still reads back in full')
  assert.equal(stillThere?.messages.at(-1)?.runId, 'run-1', 'with the run it produced still joined to it')

  // Closed means closed: no new turn may be added to an archive.
  await assert.rejects(
    () => sendMessage({ tenantId: TENANT, threadId, userId: USER, body: 'One more thing.' }, deps),
    /closed/,
  )

  await setThreadStatus({ tenantId: TENANT, threadId, userId: USER, status: 'open' }, deps)
  assert.equal(
    (await listThreads({ tenantId: TENANT, userId: USER }, deps)).length,
    1,
    'and it can be brought back',
  )
  console.log('chat: archiving takes a conversation out of the list and destroys nothing; it comes back whole')
}

// --- (c4) search reads titles and transcript; continuation keeps its branch --
{
  let tick = 0
  const clock = () => new Date(Date.parse('2026-08-17T12:00:00.000Z') + (tick += 60_000))
  const { store } = memoryChatStore(clock)
  const { run, calls } = fakeRunner('The Dawson balance is $1,240.')
  const deps = { store, run, now: clock }

  const { threadId: sourceId } = await startThread({ tenantId: TENANT, userId: USER, personId: AGENT }, deps)
  await sendMessage({ tenantId: TENANT, threadId: sourceId, userId: USER, body: 'Review the Dawson receivable.' }, deps)

  assert.equal(
    (await listThreads({ tenantId: TENANT, userId: USER, query: 'dAwSoN' }, deps))[0]?.id,
    sourceId,
    'search is case-insensitive across the title',
  )
  assert.equal(
    (await listThreads({ tenantId: TENANT, userId: USER, query: '$1,240' }, deps))[0]?.id,
    sourceId,
    'search also finds words in the immutable transcript',
  )
  assert.equal((await listThreads({ tenantId: TENANT, userId: USER, query: 'nothing here' }, deps)).length, 0)

  const continued = await continueThread({ tenantId: TENANT, userId: USER, sourceThreadId: sourceId }, deps)
  const childBefore = await getThread(TENANT, continued.threadId, deps)
  assert.equal(childBefore?.thread.originThreadId, sourceId)
  assert.equal(childBefore?.thread.originMessageSeq, 1, 'the branch point is the last recorded message')
  assert.equal(childBefore?.messages.length, 0, 'the child has its own transcript; history is linked, never copied')

  await sendMessage({ tenantId: TENANT, threadId: sourceId, userId: USER, body: 'This happened after the branch.' }, deps)
  await sendMessage({ tenantId: TENANT, threadId: continued.threadId, userId: USER, body: 'Draft a follow-up.' }, deps)
  const childInput = calls.at(-1)?.input
  const childMessage = childInput?.type === 'chat' ? childInput.message : ''
  assert.match(childMessage, /Review the Dawson receivable/)
  assert.match(childMessage, /The Dawson balance is \$1,240/)
  assert.doesNotMatch(childMessage, /This happened after the branch/, 'later source turns cannot move the branch point')
  assert.match(childMessage, /Draft a follow-up/)

  await assert.rejects(
    () => continueThread({ tenantId: TENANT, userId: OTHER_USER, sourceThreadId: sourceId }, deps),
    /belongs to someone else/,
  )
  console.log('chat: search covers titles and transcript; a continued conversation inherits exactly its branch context')
}

// --- (c5) somebody else's conversation is not theirs to keep ----------------
//
// The same rule that stops a colleague posting into a thread (block c) stops
// them renaming it or filing it away: reading is shared, keeping is not.
{
  const clock = () => new Date('2026-08-17T12:00:00.000Z')
  const { store } = memoryChatStore(clock)
  const { run } = fakeRunner()
  const deps = { store, run, now: clock }

  const { threadId } = await startThread(
    { tenantId: TENANT, userId: USER, personId: AGENT, firstMessage: 'My own conversation.' },
    deps,
  )

  await assert.rejects(
    () => renameThread({ tenantId: TENANT, threadId, userId: OTHER_USER, title: 'Mine now' }, deps),
    /belongs to someone else/,
  )
  await assert.rejects(
    () => setThreadStatus({ tenantId: TENANT, threadId, userId: OTHER_USER, status: 'closed' }, deps),
    /belongs to someone else/,
  )

  const mine = await listThreads({ tenantId: TENANT, userId: USER }, deps)
  assert.equal(mine.length, 1, 'the conversation is untouched')
  assert.equal(mine[0]?.title, 'My own conversation.', 'still called what its owner called it')
  assert.equal(mine[0]?.status, 'open', 'and still open')
  assert.deepEqual(
    await listThreads({ tenantId: TENANT, userId: OTHER_USER, includeArchived: true }, deps),
    [],
    'and never appeared on the other user’s list to begin with',
  )
  console.log('chat: another user can neither rename nor archive a conversation that is not theirs')
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
    if (/\/screen\/frames\/start$/.test(url.pathname)) {
      // The runner answers with the rate the capture is now running at, and
      // whether there was one to re-tune at all.
      return Response.json({ streaming: true, fps: body?.fps, width: body?.width, height: body?.height })
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
  assert.deepEqual(parseDeskInput({ action: 'click', x: 4, y: 9 }), { action: 'click', x: 4, y: 9, button: 'left', clicks: 1 })
  assert.deepEqual(parseDeskInput({ action: 'click', x: 4, y: 9, clicks: 2 }), { action: 'click', x: 4, y: 9, button: 'left', clicks: 2 })

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

// --- (h) the live view's rate follows what the operator is doing -------------
//
// Driving is a control loop with a person in it and gets the fast rate;
// watching is a glance and gets the slow one. Both re-tune the capture that is
// already running (`pin: false`) rather than starting one — a rate is not a
// reason to make a guest paint for nobody — and neither writes to the ledger,
// because how often we ask to see a screen is not an act on it.
{
  const recovering = deskDeps({ screenRunning: true })
  const recovered = await deskVideo(
    { tenantId: TENANT, personId: AGENT },
    recovering.deps,
  )
  assert.ok('stream' in recovered, 'an open screen reconnects to its live stream')
  const recoveredPaths = recovering.calls.map((call) => call.path)
  const startIndex = recoveredPaths.findIndex((path) => /\/screen\/start$/.test(path))
  const videoIndex = recoveredPaths.findIndex((path) => /\/screen\/video$/.test(path))
  assert.ok(startIndex >= 0 && videoIndex > startIndex, 'reconnect repairs the ephemeral screen handle before streaming')

  const closed = deskDeps({ screenRunning: false })
  const refusedClosed = await deskVideo({ tenantId: TENANT, personId: AGENT }, closed.deps)
  assert.ok('error' in refusedClosed && /not open/.test(refusedClosed.error))
  assert.equal(closed.calls.length, 0, 'a stale viewer cannot reopen a screen the ledger says was closed')

  const driving = deskDeps()
  const fast = await setDeskFrameRate({ tenantId: TENANT, personId: AGENT, driving: true }, driving.deps)
  assert.ok('ok' in fast && fast.fps === AGENT_SCREEN_DRIVING_FPS, 'driving asks for the fast rate')
  const fastCall = driving.calls.find((call) => /\/screen\/frames\/start$/.test(call.path))
  assert.ok(fastCall, 'the rate is changed on the running capture, through the runner')
  assert.equal(fastCall!.method, 'POST')
  assert.equal(fastCall!.body?.fps, AGENT_SCREEN_DRIVING_FPS)
  assert.equal(fastCall!.body?.pin, false, 're-tune only: it may never start a capture nobody is watching')
  assert.equal(driving.events.length, 0, 'a capture rate is not a step on the run record')

  const watching = deskDeps()
  const slow = await setDeskFrameRate({ tenantId: TENANT, personId: AGENT, driving: false }, watching.deps)
  assert.ok('ok' in slow && slow.fps === AGENT_SCREEN_WATCHING_FPS, 'letting go asks for the slow one again')
  assert.ok(
    AGENT_SCREEN_WATCHING_FPS < AGENT_SCREEN_DRIVING_FPS,
    'watching must cost the guest less than driving, or the whole switch is pointless',
  )

  // Same gates as everything else on this desk.
  const forbidden = deskDeps({ level: 'forbidden' })
  const refused = await setDeskFrameRate({ tenantId: TENANT, personId: AGENT, driving: true }, forbidden.deps)
  assert.ok('error' in refused, 'a forbidden dial refuses the rate change too')
  assert.equal(forbidden.calls.length, 0, 'and the runner is never touched')
  console.log('chat desk: the capture rate follows driving vs watching, re-tunes in place, and is gated')
}

// --- (i) a message to an agent who has left is refused, and the thread says so
// The gate lives in the run engine (lib/person-work.ts); what this proves is
// that the conversation handles its refusal as a record rather than an error
// toast — a question with no answer and no reason beside it is how an operator
// concludes the product is broken.
{
  const clock = () => new Date('2026-08-17T13:08:00.000Z')
  const { store } = memoryChatStore(clock)
  let calls = 0
  const run: ChatRunner = async () => {
    calls += 1
    throw new PersonNotWorkingError(AGENT, { reason: 'Bill McDonald has been offboarded and cannot start work.', permanent: true }, 'run-refused')
  }
  const deps = { store, run, now: clock }

  const { threadId } = await startThread({ tenantId: TENANT, userId: USER, personId: AGENT }, deps)
  const sent = await sendMessage({ tenantId: TENANT, threadId, userId: USER, body: 'Can you chase the Dawson invoice?' }, deps)

  assert.equal(calls, 1, 'the engine is still the one door — the refusal comes from it, not from a second rule here')
  assert.equal(sent.messages.length, 2, 'what was asked, and why nothing happened')
  assert.equal(sent.messages[1]?.role, 'system', 'the refusal is a note on the record, not the agent speaking')
  assert.match(sent.messages[1]?.body ?? '', /offboarded/, 'and it says why in words an operator reads')
  assert.equal(sent.messages[1]?.runId, 'run-refused', 'carrying the run the gate opened as evidence')

  const reread = await getThread(TENANT, threadId, deps)
  assert.equal(reread?.messages.length, 2, 'the transcript keeps both — nothing was discarded')
  console.log('chat: a message to an offboarded agent is refused on the record, not silently dropped')
}

console.log(
  'chat: messages are runs, transcripts are append-only, desk actions are gated, handovers are masked',
)
