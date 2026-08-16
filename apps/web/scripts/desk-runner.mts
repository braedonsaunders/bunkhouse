import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect as tcpConnect } from 'node:net'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import {
  cleanDeskId,
  createDeskHost,
  verifyDeskHost,
  type DeskEvent,
  type DeskHandle,
  type DeskHost,
  type DeskHostVerification,
  type DeskJob,
  type DeskScreenHandle,
} from '@appkit/desk'

/**
 * The desk runner: the only process allowed to boot a microVM. It has no
 * database, no provider keys, no session secret, and no published port —
 * mechanism lives here, and the RECORD stays in bunkhouse's tier: this
 * service buffers what happens on each desk and the web app drains it into
 * the desk_events ledger over the authenticated protocol below. AppKit
 * boundary, on purpose: this file must stay readable in one sitting and must
 * never grow a dependency on the app.
 *
 * Wire protocol 'desk-v1' (mirrored, deliberately by hand, in
 * apps/web/src/lib/desk.ts — change both together):
 *
 *   GET  /health                                — { ok, protocol, ...verification, ...stats }
 *   POST /desks/:id/lease                       — start or resume; renews when resident
 *   POST /desks/:id/executions                  — idempotent start by executionId
 *   GET  /executions/:id?wait=1                 — long-poll the retained result
 *   POST /desks/:id/jobs                        — start a keepAlive job
 *   GET  /desks/:id/jobs                        — list running keepAlive jobs
 *   POST /desks/:id/screen/start|stop           — the expensive tier, on demand
 *   GET  /desks/:id/screen/observe              — png (base64) + windows + a11y
 *   POST /desks/:id/screen/input                — click/type/key/scroll/drag/move
 *   POST /desks/:id/screen/focus                — activate a window via AT-SPI
 *   POST /desks/:id/screen/launch               — launch an app
 *   POST /desks/:id/screen/clipboard            — read/write
 *   POST /desks/:id/handover                    — begin/end, idempotent begin
 *   POST /desks/:id/suspend                     — park the VM; disk persists
 *   GET  /desks/:id/events?after=N&wait=1       — buffered typed events since seq
 *   POST /desks/:id/browser                     — ensure in-guest Chromium, return CDP path
 *   GET  /desks/:id/browser/devtools/... (WS)   — relay CDP into the guest
 *   GET  /stats                                 — host residency/queue/capacity
 */

const PORT = Number(process.env.PORT ?? 8080)
const TOKEN = process.env.BUNKHOUSE_DESK_TOKEN ?? ''
const DISKS_ROOT = process.env.BUNKHOUSE_AGENT_DISKS ?? '/data/agent-disks'
const SHARED_FOLDER = process.env.BUNKHOUSE_SHARED_FOLDER ?? '/data/shared'
const EGRESS_PROXY = process.env.BUNKHOUSE_EGRESS_PROXY ?? ''
const CAPACITY = Number(process.env.BUNKHOUSE_DESK_CAPACITY ?? 8)
const IDLE_SUSPEND_MS = Number(process.env.BUNKHOUSE_DESK_IDLE_MS ?? 5 * 60_000)
const BODY_LIMIT_BYTES = 512 * 1024
const EXEC_RETENTION_MS = 15 * 60_000
const EVENT_BUFFER_CAP = 1_000
const LONG_POLL_MS = 25_000
const CDP_PORT = 9222
const GUEST_HOME = '/home/agent'
const BROWSER_PROFILE_DIR = `${GUEST_HOME}/.config/bunkhouse-browser`
const DOWNLOADS_DIR = `${GUEST_HOME}/downloads`

/**
 * Guest addressing convention: the runner's network glue assigns each desk's
 * TAP a /24 slot and the guest the matching address, DNAT'ing all egress into
 * the proxy at EGRESS_PROXY. The CDP relay dials the guest on that address.
 * `{index}` is the per-desk index this process assigns at first lease,
 * starting at 2. Override the template when the deployment's addressing
 * differs — but keep it in step with the tap setup or the relay dials air.
 */
const GUEST_ADDR_TEMPLATE = process.env.BUNKHOUSE_GUEST_ADDR_TEMPLATE ?? '172.30.0.{index}'

if (!TOKEN) {
  console.error('[desk-runner] BUNKHOUSE_DESK_TOKEN is not set; refusing to start unauthenticated.')
  process.exit(1)
}

function tokenMatches(offered: string): boolean {
  const a = Buffer.from(offered)
  const b = Buffer.from(TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

// --- state ------------------------------------------------------------------

type DeskEntry = {
  handle: DeskHandle
  screen: DeskScreenHandle | null
  handoverUrl: string | null
  browserPath: string | null
  /** Stable per-desk index; the guest address derives from it. */
  index: number
}

type BufferedEvent = { seq: number; kind: string; at: string; detail: Record<string, unknown> }

type ExecutionEntry = {
  deskId: string
  snapshot: {
    executionId: string
    done: boolean
    result: {
      exitCode: number | null
      signal: string | null
      stdout: string
      stderr: string
      truncated: boolean
      timedOut: boolean
      startedAt: string
      finishedAt: string
    } | null
  }
  waiters: (() => void)[]
  expiresAt: number
}

const desks = new Map<string, DeskEntry>()
const deskIndexes = new Map<string, number>()
let nextDeskIndex = 2
const eventBuffers = new Map<string, { events: BufferedEvent[]; nextSeq: number; waiters: (() => void)[] }>()
const executions = new Map<string, ExecutionEntry>()

let verification: DeskHostVerification | null = null
let refusalReason: string | null = null
let host: DeskHost | null = null

function buffer(deskId: string): { events: BufferedEvent[]; nextSeq: number; waiters: (() => void)[] } {
  let entry = eventBuffers.get(deskId)
  if (!entry) {
    entry = { events: [], nextSeq: 1, waiters: [] }
    eventBuffers.set(deskId, entry)
  }
  return entry
}

/**
 * The onEvent port: every typed desk event is buffered per desk, with a
 * monotone seq, until the web tier drains it into the ledger. The record is
 * not this runner's — losing this process loses at most the undrained tail,
 * never the persisted history. Handover masking is upstream in @appkit/desk:
 * during a handover the only events that ever arrive here are the boundaries.
 */
function onDeskEvent(event: DeskEvent): void {
  const { deskId, at, kind, ...detail } = event
  const entry = buffer(deskId)
  entry.events.push({ seq: entry.nextSeq, kind, at, detail: detail as Record<string, unknown> })
  entry.nextSeq += 1
  if (entry.events.length > EVENT_BUFFER_CAP) entry.events.splice(0, entry.events.length - EVENT_BUFFER_CAP)
  for (const wake of entry.waiters.splice(0)) wake()
}

function guestAddressFor(index: number): string {
  return GUEST_ADDR_TEMPLATE.replace('{index}', String(index))
}

async function ensureDesk(
  deskId: string,
  options: { memoryMb?: number; vcpus?: number; leaseMs?: number },
): Promise<DeskEntry> {
  if (!host) throw new Error(refusalReason ?? 'This host cannot serve desks.')
  const existing = desks.get(deskId)
  if (existing) {
    try {
      if (options.leaseMs) existing.handle.renewLease(options.leaseMs)
      return existing
    } catch {
      // The host suspended it out from under us; fall through and re-lease.
      desks.delete(deskId)
    }
  }
  let index = deskIndexes.get(deskId)
  if (index === undefined) {
    index = nextDeskIndex
    nextDeskIndex += 1
    deskIndexes.set(deskId, index)
  }
  let handle: DeskHandle
  try {
    handle = await host.resume(deskId)
  } catch {
    handle = await host.start({
      deskId,
      baseImage: join(DISKS_ROOT, 'base.qcow2'),
      overlayPath: join(DISKS_ROOT, 'overlays', `${deskId}.qcow2`),
      ...(options.memoryMb ? { memoryMb: options.memoryMb } : {}),
      ...(options.vcpus ? { vcpus: options.vcpus } : {}),
      ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
    })
  }
  const entry: DeskEntry = { handle, screen: null, handoverUrl: null, browserPath: null, index }
  desks.set(deskId, entry)
  return entry
}

// --- executions: idempotent start, retained result, long-poll ---------------

function sweepExecutions(): void {
  const now = Date.now()
  for (const [id, entry] of executions) {
    if (entry.expiresAt <= now) executions.delete(id)
  }
}
setInterval(sweepExecutions, 60_000).unref()

function startExecution(
  entry: DeskEntry,
  deskId: string,
  body: {
    executionId: string
    command: string[]
    cwd?: string
    env?: Record<string, string>
    timeoutMs?: number
    outputLimitKb?: number
  },
): ExecutionEntry {
  const known = executions.get(body.executionId)
  if (known) return known
  const timeoutMs = Math.min(Math.max(body.timeoutMs ?? 60_000, 1_000), 600_000)
  const cap = Math.min(Math.max(body.outputLimitKb ?? 64, 1), 8_192) * 1_024
  const execution: ExecutionEntry = {
    deskId,
    snapshot: { executionId: body.executionId, done: false, result: null },
    waiters: [],
    expiresAt: Date.now() + timeoutMs + EXEC_RETENTION_MS,
  }
  executions.set(body.executionId, execution)
  const startedAt = Date.now()
  const [command, ...args] = body.command
  void entry.handle
    .exec({
      command: command ?? '/bin/false',
      args,
      ...(body.cwd ? { cwd: body.cwd } : {}),
      ...(body.env ? { env: body.env } : {}),
      timeoutMs,
    })
    .then((snapshot) => {
      const elapsed = Date.now() - startedAt
      execution.snapshot.result = {
        exitCode: snapshot.exitCode,
        signal: snapshot.signal,
        stdout: snapshot.stdout.slice(0, cap),
        stderr: snapshot.stderr.slice(0, cap),
        truncated: snapshot.truncated || snapshot.stdout.length > cap || snapshot.stderr.length > cap,
        timedOut: snapshot.signal !== null && elapsed >= timeoutMs,
        startedAt: snapshot.startedAt,
        finishedAt: snapshot.finishedAt,
      }
    })
    .catch((error: unknown) => {
      const stamp = new Date().toISOString()
      execution.snapshot.result = {
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        truncated: false,
        timedOut: false,
        startedAt: stamp,
        finishedAt: stamp,
      }
    })
    .finally(() => {
      execution.snapshot.done = true
      execution.expiresAt = Date.now() + EXEC_RETENTION_MS
      for (const wake of execution.waiters.splice(0)) wake()
    })
  return execution
}

// --- the in-guest browser and its CDP relay ---------------------------------

/**
 * Fetch Chromium's /json/version FROM INSIDE the guest, with nothing but
 * bash — the base image is deliberately short and this needs no extra
 * package. Returns the devtools websocket path, e.g. /devtools/browser/<id>.
 */
async function guestBrowserPath(entry: DeskEntry): Promise<string | null> {
  const probe =
    'exec 3<>/dev/tcp/127.0.0.1/9222; ' +
    'printf "GET /json/version HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\n\\r\\n" >&3; cat <&3'
  const snapshot = await entry.handle
    .exec({ command: '/bin/bash', args: ['-c', probe], timeoutMs: 5_000 })
    .catch(() => null)
  if (!snapshot || snapshot.exitCode !== 0) return null
  const match = /"webSocketDebuggerUrl":\s*"ws:\/\/[^/]+(\/devtools\/browser\/[^"]+)"/.exec(snapshot.stdout)
  return match?.[1] ?? null
}

async function ensureGuestBrowser(entry: DeskEntry): Promise<string> {
  if (entry.browserPath) {
    const path = await guestBrowserPath(entry)
    if (path) {
      entry.browserPath = path
      return path
    }
    entry.browserPath = null
  }
  // The persistent profile and the downloads folder live in the guest home:
  // this is what makes logins survive across runs and puts downloaded files
  // where run_shell can see them.
  await entry.handle.exec({
    command: '/bin/mkdir',
    args: ['-p', BROWSER_PROFILE_DIR, DOWNLOADS_DIR],
    timeoutMs: 10_000,
  })
  const running: DeskJob[] = entry.handle.jobs()
  if (!running.some((job) => job.status === 'running' && job.command.includes('chromium'))) {
    await entry.handle.exec({
      command: '/usr/bin/chromium',
      args: [
        '--headless=new',
        `--remote-debugging-port=${CDP_PORT}`,
        '--remote-debugging-address=0.0.0.0',
        `--user-data-dir=${BROWSER_PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--mute-audio',
        '--hide-scrollbars',
      ],
      keepAlive: true,
    })
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const path = await guestBrowserPath(entry)
    if (path) {
      entry.browserPath = path
      return path
    }
    await delay(500)
  }
  throw new Error('The in-guest browser did not come up.')
}

/**
 * Relay a CDP websocket into the guest. Raw byte splice on purpose: the
 * upgrade handshake and every websocket frame pass through untouched, so
 * this needs no websocket implementation and cannot corrupt one. Chromium
 * refuses non-local Host headers on the devtools endpoint, so the head is
 * rewritten to claim 127.0.0.1 before it is forwarded.
 */
function relayBrowserSocket(request: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(request.url ?? '/', 'http://desk-runner')
  const match = /^\/desks\/([^/]+)\/browser(\/devtools\/.*)$/.exec(url.pathname)
  const token = url.searchParams.get('token') ?? ''
  if (!match || !tokenMatches(token)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    return
  }
  const entry = desks.get(decodeURIComponent(match[1] ?? ''))
  if (!entry) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
    return
  }
  const upstream = tcpConnect(CDP_PORT, guestAddressFor(entry.index))
  upstream.on('connect', () => {
    const lines = [`GET ${match[2]} HTTP/1.1`, `Host: 127.0.0.1:${CDP_PORT}`]
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i] ?? ''
      const value = request.rawHeaders[i + 1] ?? ''
      if (/^(host|authorization)$/i.test(name)) continue
      lines.push(`${name}: ${value}`)
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n')
    if (head.length > 0) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  const drop = () => {
    upstream.destroy()
    socket.destroy()
  }
  upstream.on('error', drop)
  socket.on('error', drop)
}

// --- HTTP plumbing ----------------------------------------------------------

function reply(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  response.end(text)
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  request.setEncoding('utf8')
  for await (const chunk of request) {
    raw += String(chunk)
    if (Buffer.byteLength(raw) > BODY_LIMIT_BYTES) throw new Error('request body is too large')
  }
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new Error('request body is not JSON')
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function waitFor(register: (wake: () => void) => void, ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms)
    register(() => {
      clearTimeout(timer)
      resolvePromise()
    })
  })
}

// --- routing ----------------------------------------------------------------

const server = createServer((request, response) => {
  void route(request, response).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[desk-runner] ${message}`)
    if (!response.headersSent) reply(response, 500, { error: message })
    else response.destroy()
  })
})

server.on('upgrade', (request, socket, head) => {
  try {
    relayBrowserSocket(request, socket, head)
  } catch {
    socket.destroy()
  }
})

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://desk-runner')

  if (request.method === 'GET' && url.pathname === '/health') {
    const ok = verification?.supported === true
    reply(response, ok ? 200 : 503, {
      ok,
      protocol: 'desk-v1',
      ...(verification ?? {}),
      ...(refusalReason ? { reason: refusalReason } : {}),
      ...(host ? host.stats() : {}),
    })
    return
  }

  const offered = (request.headers.authorization ?? '').replace(/^Bearer /i, '')
  if (!tokenMatches(offered)) {
    reply(response, 401, { error: 'unauthorized' })
    return
  }
  if (!host || verification?.supported !== true) {
    // Fail closed: an unsupported host serves nothing but its reason.
    reply(response, 503, { error: refusalReason ?? 'This host cannot serve desks.' })
    return
  }

  if (request.method === 'GET' && url.pathname === '/stats') {
    reply(response, 200, host.stats())
    return
  }

  const execMatch = /^\/executions\/([^/]+)$/.exec(url.pathname)
  if (execMatch && request.method === 'GET') {
    const executionId = decodeURIComponent(execMatch[1] ?? '')
    const execution = executions.get(executionId)
    if (!execution) {
      reply(response, 404, { error: 'execution not found or expired' })
      return
    }
    if (!execution.snapshot.done && url.searchParams.get('wait')) {
      await waitFor((wake) => execution.waiters.push(wake), LONG_POLL_MS)
    }
    reply(response, 200, execution.snapshot)
    return
  }

  const deskMatch = /^\/desks\/([^/]+)(\/.*)?$/.exec(url.pathname)
  if (!deskMatch) {
    reply(response, 404, { error: 'not found' })
    return
  }
  let deskId: string
  try {
    deskId = cleanDeskId(decodeURIComponent(deskMatch[1] ?? ''))
  } catch (error) {
    reply(response, 400, { error: error instanceof Error ? error.message : 'bad desk id' })
    return
  }
  const rest = deskMatch[2] ?? ''

  if (request.method === 'POST' && rest === '/lease') {
    const body = await readBody(request)
    await ensureDesk(deskId, {
      memoryMb: numberOr(body.memoryMb),
      vcpus: numberOr(body.vcpus),
      leaseMs: numberOr(body.leaseMs),
    })
    reply(response, 200, { deskId, resident: true, ...host.stats() })
    return
  }

  if (request.method === 'GET' && rest.startsWith('/events')) {
    const after = Number(url.searchParams.get('after') ?? 0)
    if (!Number.isSafeInteger(after) || after < 0) {
      reply(response, 400, { error: 'after must be a non-negative integer' })
      return
    }
    const entry = buffer(deskId)
    let events = entry.events.filter((event) => event.seq > after)
    if (events.length === 0 && url.searchParams.get('wait')) {
      await waitFor((wake) => entry.waiters.push(wake), LONG_POLL_MS)
      events = entry.events.filter((event) => event.seq > after)
    }
    reply(response, 200, { events })
    return
  }

  if (request.method === 'POST' && rest === '/executions') {
    const body = await readBody(request)
    if (typeof body.executionId !== 'string' || !Array.isArray(body.command) || body.command.length === 0) {
      reply(response, 400, { error: 'executionId and a non-empty command array are required' })
      return
    }
    const entry = await ensureDesk(deskId, {})
    const execution = startExecution(entry, deskId, {
      executionId: body.executionId,
      command: body.command.map(String),
      ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {}),
      ...(body.env && typeof body.env === 'object' ? { env: body.env as Record<string, string> } : {}),
      ...(numberOr(body.timeoutMs) !== undefined ? { timeoutMs: numberOr(body.timeoutMs) } : {}),
      ...(numberOr(body.outputLimitKb) !== undefined ? { outputLimitKb: numberOr(body.outputLimitKb) } : {}),
    })
    reply(response, 202, execution.snapshot)
    return
  }

  if (request.method === 'POST' && rest === '/jobs') {
    const body = await readBody(request)
    if (!Array.isArray(body.command) || body.command.length === 0) {
      reply(response, 400, { error: 'a non-empty command array is required' })
      return
    }
    const entry = await ensureDesk(deskId, {})
    const [command, ...args] = body.command.map(String)
    const job = await entry.handle.exec({ command: command ?? '/bin/false', args, keepAlive: true })
    reply(response, 202, job)
    return
  }

  if (request.method === 'GET' && rest === '/jobs') {
    const entry = desks.get(deskId)
    reply(response, 200, { jobs: entry ? entry.handle.jobs() : [] })
    return
  }

  if (request.method === 'POST' && rest === '/screen/start') {
    const body = await readBody(request)
    const entry = await ensureDesk(deskId, {})
    if (!entry.handle.screen.running) {
      entry.screen = await entry.handle.screen.start({
        width: numberOr(body.width) ?? 1280,
        height: numberOr(body.height) ?? 900,
      })
    }
    reply(response, 200, { running: true })
    return
  }

  if (request.method === 'POST' && rest === '/screen/stop') {
    const entry = desks.get(deskId)
    if (entry?.handle.screen.running) await entry.handle.screen.stop()
    if (entry) {
      entry.screen = null
      entry.handoverUrl = null
    }
    reply(response, 200, { running: false })
    return
  }

  // Everything below needs a running screen.
  if (rest.startsWith('/screen/') || rest === '/handover') {
    const entry = desks.get(deskId)
    const screen = entry?.screen ?? null
    if (!entry || !screen) {
      reply(response, 409, { error: 'no screen is running on this desk' })
      return
    }

    if (request.method === 'GET' && rest === '/screen/observe') {
      const observation = await screen.observe()
      reply(response, 200, {
        png: observation.png.toString('base64'),
        width: observation.width,
        height: observation.height,
        a11y: observation.a11y,
        windows: observation.windows,
        focused: observation.focused,
      })
      return
    }

    if (request.method === 'POST' && rest === '/screen/input') {
      const body = await readBody(request)
      const action = String(body.action ?? '')
      switch (action) {
        case 'move':
          await screen.input.move(Number(body.x), Number(body.y))
          break
        case 'click':
          await screen.input.click(
            Number(body.x),
            Number(body.y),
            body.button === 'middle' || body.button === 'right' ? body.button : 'left',
          )
          break
        case 'type':
          await screen.input.type(String(body.text ?? ''))
          break
        case 'key':
          await screen.input.key(String(body.combo ?? ''))
          break
        case 'scroll':
          await screen.input.scroll(Number(body.x), Number(body.y), Number(body.dx ?? 0), Number(body.dy ?? 0))
          break
        case 'drag': {
          const from = body.from as { x: number; y: number }
          const to = body.to as { x: number; y: number }
          await screen.input.drag(
            { x: Number(from?.x), y: Number(from?.y) },
            { x: Number(to?.x), y: Number(to?.y) },
          )
          break
        }
        default:
          reply(response, 400, { error: `unknown input action "${action}"` })
          return
      }
      reply(response, 200, { done: true })
      return
    }

    if (request.method === 'POST' && rest === '/screen/focus') {
      const body = await readBody(request)
      await screen.a11y.invoke(String(body.windowId ?? ''), 'activate')
      reply(response, 200, { done: true })
      return
    }

    if (request.method === 'POST' && rest === '/screen/launch') {
      const body = await readBody(request)
      await screen.launch(String(body.appId ?? ''), Array.isArray(body.args) ? body.args.map(String) : [])
      reply(response, 200, { done: true })
      return
    }

    if (request.method === 'POST' && rest === '/screen/clipboard') {
      const body = await readBody(request)
      if (body.op === 'write') {
        await screen.clipboard.write(String(body.text ?? ''))
        reply(response, 200, { done: true })
      } else {
        reply(response, 200, { text: await screen.clipboard.read() })
      }
      return
    }

    if (request.method === 'POST' && rest === '/handover') {
      const body = await readBody(request)
      if (body.op === 'end') {
        await screen.handover.end()
        entry.handoverUrl = null
        reply(response, 200, { ended: true })
        return
      }
      // Idempotent begin: an approval replay reopens the SAME handover rather
      // than erroring or stacking a second one.
      if (screen.handover.active && entry.handoverUrl) {
        reply(response, 200, { url: entry.handoverUrl })
        return
      }
      const { url: handoverUrl } = await screen.handover.begin({
        ttlMs: numberOr(body.ttlMs) ?? 15 * 60_000,
        scope: body.scope === 'view' ? 'view' : 'control',
        ...(typeof body.actor === 'string' ? { actor: body.actor } : {}),
      })
      entry.handoverUrl = handoverUrl
      reply(response, 200, { url: handoverUrl })
      return
    }
  }

  if (request.method === 'POST' && rest === '/suspend') {
    await host.suspend(deskId)
    desks.delete(deskId)
    reply(response, 200, { suspended: true })
    return
  }

  if (request.method === 'POST' && rest === '/browser') {
    const entry = await ensureDesk(deskId, {})
    const path = await ensureGuestBrowser(entry)
    reply(response, 200, { path })
    return
  }

  reply(response, 404, { error: 'not found' })
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// --- boot -------------------------------------------------------------------

server.listen(PORT, () => {
  console.log(
    `[desk-runner] listening on ${PORT}; disks ${DISKS_ROOT}; shared folder ${SHARED_FOLDER}` +
      (EGRESS_PROXY ? `; egress via ${EGRESS_PROXY}` : '; NO egress proxy configured'),
  )
  void verifyDeskHost({
    kernelPath: join(DISKS_ROOT, 'vmlinux'),
    baseImagePath: join(DISKS_ROOT, 'base.qcow2'),
  })
    .then((result) => {
      verification = result
      if (!result.supported) {
        refusalReason = result.kvm
          ? 'The probe desk booted but its guest agent never answered over vsock.'
          : 'KVM is not available. Desks require hardware virtualization; there is no software-emulation fallback.'
        console.error(`[desk-runner] DESKS REFUSED: ${refusalReason}`)
        return
      }
      host = createDeskHost({
        imageRoot: DISKS_ROOT,
        capacity: CAPACITY,
        idleSuspendMs: IDLE_SUSPEND_MS,
        ports: {
          // Governance deliberately does NOT live here (spec §3.22): the dial
          // and the feature gate are enforced in bunkhouse's tier before a
          // request ever reaches this process, and per-command gating on a
          // root shell enforces nothing. Real enforcement is the egress
          // proxy, what is mounted, and the ledger the events below feed.
          onEvent: onDeskEvent,
          audit: (auditEntry) => console.log(`[desk-runner] audit ${JSON.stringify(auditEntry)}`),
        },
      })
      console.log(
        `[desk-runner] desks ready — kvm=${result.kvm} vsock=${result.vsock} virtioGpu=${result.virtioGpu}, capacity ${CAPACITY}`,
      )
    })
    .catch((error: unknown) => {
      refusalReason = error instanceof Error ? error.message : String(error)
      verification = { supported: false, vmmPath: '', kvm: false, vsock: false, virtioGpu: false }
      console.error(`[desk-runner] DESKS REFUSED: ${refusalReason}`)
    })
})
