import assert from 'node:assert/strict'
import sharp from 'sharp'
import { governedToolSet, type Ability, type ActionCategory, type AutonomyLevel, type GovernanceState } from '@bunkhouse/runtime'

// The desk cutover, proved with the runner faked out: fail-closed capability
// detection, the run_shell round trip landing on the desk ledger, the
// recorded escalation reason, the screen-session step ceiling, idempotent
// takeover reopening, the sandbox/desktop dial split (§3.21), and the live
// view reaching the call stage (§3.13) — all with no desk host, no database,
// and no model in the loop.

delete process.env.BUNKHOUSE_DESK_URL
delete process.env.BUNKHOUSE_DESK_TOKEN

const desk = await import('../src/lib/desk')
const { DEFAULT_DESK_POLICY } = await import('../src/lib/desk-policy')
const {
  DEFAULT_SHELL_EXECUTION_POLICY,
  deskAbilities,
  deskIdFor,
  deskSupported,
} = desk

/** A real (tiny) PNG, so the cast's decode path is the genuine one. */
const FRAME_PNG = await sharp({
  create: { width: 8, height: 8, channels: 3, background: '#123456' },
})
  .png()
  .toBuffer()

type StoreEvent = {
  sessionId: string
  seq: number
  kind: string
  detail: Record<string, unknown>
  screenshotFileId?: string | null
}

function memoryStore() {
  const sessions: { id: string; tenantId: string; personId: string; runId: string; status: string; screenReason: string | null }[] = []
  const events: StoreEvent[] = []
  const jobs: { jobId: string; command: string; status: string }[] = []
  const store: NonNullable<NonNullable<Parameters<typeof deskAbilities>[0]['deps']>['store']> = {
    async openSession({ tenantId, personId, runId }) {
      const existing = sessions.find((s) => s.tenantId === tenantId && s.runId === runId)
      if (existing) {
        const seq = events.filter((e) => e.sessionId === existing.id).reduce((max, e) => Math.max(max, e.seq), 0)
        return { id: existing.id, seq }
      }
      const id = `session-${sessions.length + 1}`
      sessions.push({ id, tenantId, personId, runId, status: 'active', screenReason: null })
      return { id, seq: 0 }
    },
    async appendEvent(args) {
      events.push({
        sessionId: args.sessionId,
        seq: args.seq,
        kind: args.kind,
        detail: args.detail as Record<string, unknown>,
        screenshotFileId: args.screenshotFileId ?? null,
      })
    },
    async markScreenOpened({ sessionId, reason }) {
      const session = sessions.find((s) => s.id === sessionId)
      if (session) session.screenReason = reason
    },
    async markSessionStatus({ sessionId, status }) {
      const session = sessions.find((s) => s.id === sessionId)
      if (session) session.status = status
    },
    async upsertJobStart({ jobId, command }) {
      if (!jobs.some((j) => j.jobId === jobId)) jobs.push({ jobId, command, status: 'running' })
    },
    async markJobExit({ jobId }) {
      const job = jobs.find((j) => j.jobId === jobId)
      if (job) job.status = 'exited'
    },
  }
  return { store, sessions, events, jobs }
}

/** A fake desk runner speaking just enough desk-v1 for the abilities. */
function fakeRunner() {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
  const counters = { lease: 0, exec: 0, input: 0, screenStart: 0, handover: 0, framesOpen: 0, framesStop: 0 }
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    calls.push({ method, path: url.pathname, ...(body ? { body } : {}) })

    if (method === 'POST' && /\/lease$/.test(url.pathname)) {
      counters.lease += 1
      return Response.json({ resident: true })
    }
    if (method === 'POST' && /\/executions$/.test(url.pathname)) {
      counters.exec += 1
      const command = (body?.command as string[]) ?? []
      const stamp = '2026-08-16T12:00:00.000Z'
      return Response.json(
        {
          executionId: body?.executionId,
          done: true,
          result: {
            exitCode: 0,
            signal: null,
            stdout: command.join(' ').includes('echo hello') ? 'hello\n' : 'ok\n',
            stderr: '',
            truncated: false,
            timedOut: false,
            startedAt: stamp,
            finishedAt: stamp,
          },
        },
        { status: 202 },
      )
    }
    if (method === 'GET' && /\/events/.test(url.pathname)) {
      return Response.json({ events: [] })
    }
    if (method === 'POST' && /\/screen\/start$/.test(url.pathname)) {
      counters.screenStart += 1
      return Response.json({ running: true })
    }
    if (method === 'GET' && /\/screen\/observe$/.test(url.pathname)) {
      return Response.json({
        png: Buffer.from('not-a-real-png').toString('base64'),
        width: 1280,
        height: 900,
        a11y: null,
        windows: [{ id: 'w1', title: 'Files', appId: 'thunar' }],
        focused: { id: 'w1', title: 'Files', appId: 'thunar' },
      })
    }
    if (method === 'POST' && /\/screen\/input$/.test(url.pathname)) {
      counters.input += 1
      return Response.json({ done: true })
    }
    if (method === 'POST' && /\/handover$/.test(url.pathname)) {
      counters.handover += 1
      const stream = `${url.pathname}/stream?expires=1786896900000&scope=control&nonce=0123456789abcdef&capability=signed`
      return Response.json({
        url: stream,
        stream,
        expiresAt: '2026-08-16T12:15:00.000Z',
      })
    }
    if (method === 'GET' && /\/screen\/frames$/.test(url.pathname)) {
      counters.framesOpen += 1
      // One frame, then the stream stays open with no timers pending — the
      // damage-driven capture a still screen produces, exactly.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const payload = JSON.stringify({
            seq: 1,
            width: 1280,
            height: 900,
            data: FRAME_PNG.toString('base64'),
          })
          controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`))
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (method === 'POST' && /\/screen\/frames\/stop$/.test(url.pathname)) {
      counters.framesStop += 1
      return Response.json({ streaming: false })
    }
    return Response.json({ error: `unexpected ${method} ${url.pathname}` }, { status: 404 })
  }) as typeof fetch
  return { fetchImpl, calls, counters }
}

const TENANT = '0194b8a2-3b74-7000-8000-000000000001'
const person = { id: '0194b8a2-3b74-7000-8000-0000000000aa', name: 'Avery' } as unknown as Parameters<
  typeof deskAbilities
>[0]['person']

function build(runId: string) {
  const { store, sessions, events } = memoryStore()
  const { fetchImpl, calls, counters } = fakeRunner()
  const savedFrames: string[] = []
  const abilities = deskAbilities({
    tenantId: TENANT,
    person,
    runId,
    features: { desk: true, desktop: true },
    deps: {
      runner: { url: 'http://desk.internal', token: 'secret' },
      fetch: fetchImpl,
      store,
      policy: async () => ({ ...DEFAULT_DESK_POLICY, screenStepCeiling: 2 }),
      shellPolicy: async () => DEFAULT_SHELL_EXECUTION_POLICY,
      saveScreenshot: async () => {
        const id = `file-${savedFrames.length + 1}`
        savedFrames.push(id)
        return id
      },
    },
  })
  const call = async (name: string, input: unknown): Promise<Record<string, unknown>> => {
    const ability = abilities.find((a) => a.name === name)
    assert.ok(ability?.tool.execute, `${name} is offered and executable`)
    return (await ability.tool.execute!(input as never, { toolCallId: 't', messages: [] })) as Record<string, unknown>
  }
  return { abilities, call, sessions, events, calls, counters, savedFrames }
}

// --- (a) fail closed without a configured runner ----------------------------
{
  assert.equal(deskSupported(), false, 'no BUNKHOUSE_DESK_URL means no desk')
  const withoutRunner = deskAbilities({
    tenantId: TENANT,
    person,
    runId: 'run-none',
    features: { desk: true, desktop: true },
  })
  assert.deepEqual(withoutRunner, [], 'no runner: the abilities are withheld entirely, not degraded')
  const featureOff = deskAbilities({
    tenantId: TENANT,
    person,
    runId: 'run-off',
    features: { desk: false, desktop: false },
    deps: { runner: { url: 'http://desk.internal', token: 'secret' } },
  })
  assert.deepEqual(featureOff, [], 'the desk feature gate withholds the whole spread')
  console.log('desk: fails closed without a runner and behind the feature gate')
}

// --- (b) run_shell round-trips through the runner onto the ledger -----------
{
  const { call, sessions, events, calls } = build('run-shell-test')
  const result = await call('run_shell', { command: 'echo hello', cwd: '.' })
  assert.equal(result.status, 'completed')
  assert.match(String(result.output), /hello/)
  assert.equal(sessions.length, 1, 'one desk session row per run')
  const shellEvents = events.filter((e) => e.kind === 'shell_command')
  assert.equal(shellEvents.length, 1, 'the command landed on the ledger')
  assert.equal(shellEvents[0]?.detail.command, 'echo hello')
  assert.equal(shellEvents[0]?.detail.exitCode, 0)
  const started = calls.find((c) => /\/executions$/.test(c.path))
  assert.ok(typeof started?.body?.executionId === 'string', 'the start is idempotent by execution id')
  const leased = calls.find((c) => /\/lease$/.test(c.path))
  assert.ok(leased, 'the desk was leased before the command ran')
  assert.match(leased!.path, new RegExp(deskIdFor(TENANT, (person as { id: string }).id)))
  console.log('desk: run_shell executes on the desk and persists a session + shell_command event')
}

// --- (c) open_desktop requires and records the reason ------------------------
{
  const { call, sessions, events, counters, savedFrames } = build('run-screen-test')
  const refused = await call('open_desktop', { reason: '' })
  assert.equal(refused.opened, false, 'a blank reason does not open a screen')
  assert.equal(counters.screenStart, 0, 'nothing reached the runner without a reason')

  const opened = await call('open_desktop', { reason: 'Vendor portal is a GTK app with no CLI or API.' })
  assert.equal(opened.opened, true)
  assert.equal(counters.screenStart, 1)
  assert.equal(sessions[0]?.screenReason, 'Vendor portal is a GTK app with no CLI or API.')
  const screenOpen = events.find((e) => e.kind === 'screen_open')
  assert.ok(screenOpen, 'screen_open is on the ledger')
  assert.equal(screenOpen?.detail.reason, 'Vendor portal is a GTK app with no CLI or API.')
  assert.equal(screenOpen?.screenshotFileId, 'file-1', 'the opening frame is filed')
  const unchanged = await call('desktop_click', { x: 10, y: 10, button: 'left' })
  assert.equal(unchanged.frameUnchanged, true, 'an exact repeated frame is identified')
  assert.equal(savedFrames.length, 1, 'an exact repeated frame reuses its filed image')
  const click = events.find((event) => event.kind === 'click')
  assert.equal(click?.screenshotFileId, 'file-1', 'the repeated event points to the original evidence')
  assert.equal(click?.detail.frameRepeated, true, 'the ledger explains why no second image was filed')
  console.log('desk: the screen opens only with a stated reason, and the reason is recorded')
}

// --- (d) the per-screen-session step ceiling cuts off ------------------------
{
  const { call, counters } = build('run-budget-test')
  await call('open_desktop', { reason: 'Budget test needs a screen.' })
  const first = await call('desktop_click', { x: 10, y: 10, button: 'left' })
  assert.ok(!first.error, 'step 1 is within the ceiling')
  const second = await call('desktop_click', { x: 20, y: 20, button: 'left' })
  assert.ok(!second.error, 'step 2 is within the ceiling')
  const third = await call('desktop_click', { x: 30, y: 30, button: 'left' })
  assert.match(String(third.error ?? ''), /steps/, 'step 3 is refused by the policy ceiling')
  assert.equal(counters.input, 2, 'the refused step never reached the runner')
  console.log('desk: the screen step ceiling from desk policy cuts off at the limit')
}

// --- (e) request_takeover replays idempotently -------------------------------
{
  const { call, events } = build('run-takeover-test')
  const input = { reason: 'Complete the 2FA login with the code on your phone.', scope: 'control', ttlMinutes: 15 }
  const first = await call('request_takeover', input)
  assert.equal(first.granted, true)
  assert.match(String(first.url), /^ws:\/\/desk\.internal\/desks\//)
  assert.doesNotMatch(String(first.url), /token=secret/, 'the runner bearer never reaches the browser')
  assert.match(String(first.url), /capability=signed/, 'the handover has only its scoped capability')
  // The approval executor replays the SAME input later, possibly in another
  // process — the second call must land on the same handover, not error.
  const replay = await call('request_takeover', input)
  assert.equal(replay.granted, true)
  assert.equal(replay.url, first.url, 'the replay reopens the same handover')
  assert.ok(
    events.some((e) => e.kind === 'handover_begin' && e.detail.reason === input.reason),
    'the handover boundary is on the ledger with its reason — never its content',
  )
  console.log('desk: request_takeover carries everything in its input and replays idempotently')
}

// --- (e2) the live view: a desktop opened during a call reaches the stage ----
{
  const { registerBrowserCast } = await import('../src/lib/browser-cast')
  const { AGENT_SCREEN_HEIGHT, AGENT_SCREEN_WIDTH } = await import('../src/lib/agent-screen')

  // Nobody watching: opening a desktop must cost no capture at all.
  const quiet = build('run-cast-quiet')
  await quiet.call('open_desktop', { reason: 'No call is listening to this one.' })
  assert.equal(quiet.counters.framesOpen, 0, 'an unwatched run opens no frame stream')

  // A call registers its opener for the run, exactly as voice-agent.mts does.
  const published: { width: number; height: number; bytes: number }[] = []
  let openedAt: { width: number; height: number } | null = null
  let closed = false
  const stopOffer = registerBrowserCast('run-cast-live', async (size) => {
    openedAt = size
    return {
      publish: (frame) => published.push({ width: frame.width, height: frame.height, bytes: frame.data.length }),
      close: async () => {
        closed = true
      },
    }
  })

  const live = build('run-cast-live')
  await live.call('open_desktop', { reason: 'A GTK-only vendor portal, and the caller wants to watch.' })
  assert.equal(live.counters.framesOpen, 1, 'opening the desktop subscribed to the guest frames')
  const framesCall = live.calls.find((c) => /\/screen\/frames$/.test(c.path))
  assert.ok(framesCall, 'the frame stream is the desk-v1 SSE endpoint')
  assert.deepEqual(
    openedAt,
    { width: AGENT_SCREEN_WIDTH, height: AGENT_SCREEN_HEIGHT },
    'the track opens at the one size the desk, the capture and the stage agree on',
  )

  for (let attempt = 0; attempt < 50 && published.length === 0; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
  assert.equal(published.length, 1, 'the guest frame reached the publisher')
  assert.equal(published[0]?.width, AGENT_SCREEN_WIDTH, 'published at the track contract width')
  assert.equal(published[0]?.height, AGENT_SCREEN_HEIGHT, 'published at the track contract height')
  assert.equal(
    published[0]?.bytes,
    AGENT_SCREEN_WIDTH * AGENT_SCREEN_HEIGHT * 4,
    'packed RGBA, no padding — what the video source wants',
  )

  await live.call('close_desktop', {})
  assert.equal(live.counters.framesStop, 1, 'closing the desktop stopped the guest capture')
  assert.equal(closed, true, 'and unpublished the track')
  await stopOffer()
  console.log('desk: a desktop opened during a call casts to the stage, and closing it takes the track down')
}

// --- (f) dial separation: desktop forbidden does not touch the machine -------
{
  const { abilities } = build('run-dials-test')
  const state: GovernanceState = { pendingApprovalId: null, pendingWait: null }
  const levels: Partial<Record<ActionCategory, AutonomyLevel>> = { sandbox: 'trusted', desktop: 'forbidden' }
  const tools = governedToolSet({
    abilities: abilities as Ability[],
    autonomy: (category) => levels[category] ?? 'approval',
    approvals: { request: async () => ({ approvalId: 'appr-1' }) },
    sink: { event: async () => {}, spend: async () => {} },
    state,
  })
  const clicked = (await tools.desktop_click!.execute!(
    { x: 1, y: 1, button: 'left' } as never,
    { toolCallId: 't', messages: [] },
  )) as { status?: string }
  assert.equal(clicked.status, 'forbidden', 'the desktop dial blocks the screen')
  const ran = (await tools.run_shell!.execute!(
    { command: 'echo hello', cwd: '.' } as never,
    { toolCallId: 't', messages: [] },
  )) as { status?: string }
  assert.equal(ran.status, 'completed', 'the sandbox dial still lets the machine work (§3.21)')
  console.log('desk: forbidding the desktop dial blocks desktop_* without touching run_shell')
}

console.log('desk: fail-closed support, ledgered shell, recorded escalation, bounded screen, idempotent takeover, split dials')
