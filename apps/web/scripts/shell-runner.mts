import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  cancelShellExecution,
  disposeShellExecution,
  insideRoot,
  resolveShellExecutionPolicy,
  runSandboxedShell,
  shellSupervisorStats,
  startSandboxedShell,
  waitForShellExecution,
  type ShellExecutionPolicy,
} from '../src/lib/shell-sandbox'

/**
 * The only container allowed to build a bubblewrap sandbox. It has no database,
 * provider keys, session secret, or published port. AppKit supervises commands
 * beyond the HTTP request that started them, while this boundary authenticates
 * every operation and constrains writable paths to the mounted homes root.
 */

const PORT = Number(process.env.PORT ?? 8080)
const TOKEN = process.env.BUNKHOUSE_SHELL_TOKEN ?? ''
const HOMES_ROOT = process.env.BUNKHOUSE_AGENT_HOMES ?? '/data/agent-homes'
const BODY_LIMIT_BYTES = 256 * 1024
let sandboxReady = false

if (!TOKEN) {
  console.error('[shell-runner] BUNKHOUSE_SHELL_TOKEN is not set; refusing to start unauthenticated.')
  process.exit(1)
}

function tokenMatches(offered: string): boolean {
  const a = Buffer.from(offered)
  const b = Buffer.from(TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

type RunRequest = {
  executionId?: unknown
  home?: unknown
  cwd?: unknown
  command?: unknown
  policy?: unknown
}

const server = createServer((request, response) => {
  void route(request, response).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[shell-runner] ${message}`)
    if (!response.headersSent) reply(response, 500, { error: message })
    else response.destroy()
  })
})

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://shell-runner')
  if (request.method === 'GET' && url.pathname === '/health') {
    reply(response, sandboxReady ? 200 : 503, {
      ok: sandboxReady,
      protocol: 'supervised-v1',
      ...shellSupervisorStats(),
    })
    return
  }

  const offered = (request.headers.authorization ?? '').replace(/^Bearer /i, '')
  if (!tokenMatches(offered)) {
    reply(response, 401, { error: 'unauthorized' })
    return
  }

  if (request.method === 'POST' && url.pathname === '/executions') {
    const body = await readBody(request)
    const { executionId, home, cwd, command } = body
    if (
      typeof executionId !== 'string'
      || typeof home !== 'string'
      || typeof cwd !== 'string'
      || typeof command !== 'string'
    ) {
      reply(response, 400, { error: 'executionId, home, cwd and command are required strings' })
      return
    }
    if (!insideRoot(HOMES_ROOT, home)) {
      reply(response, 403, { error: 'that home is not inside this runner’s workspace root' })
      return
    }
    if (!insideRoot(home, cwd)) {
      reply(response, 403, { error: 'that working directory is not inside that home' })
      return
    }
    if (body.policy !== undefined && (!body.policy || typeof body.policy !== 'object')) {
      reply(response, 400, { error: 'policy must be an object' })
      return
    }
    const policy = resolveShellExecutionPolicy(body.policy as Partial<ShellExecutionPolicy> | undefined)
    const snapshot = await startSandboxedShell({ executionId, home, cwd, command, policy })
    reply(response, 202, snapshot)
    return
  }

  const match = /^\/executions\/([^/]+)$/.exec(url.pathname)
  if (match && request.method === 'GET') {
    const executionId = decodeURIComponent(match[1] ?? '')
    const after = Number(url.searchParams.get('after') ?? 0)
    if (!Number.isSafeInteger(after) || after < 0) {
      reply(response, 400, { error: 'after must be a non-negative integer' })
      return
    }
    const snapshot = await waitForShellExecution(executionId, after, {
      timeoutMs: 25_000,
      signal: AbortSignal.timeout(26_000),
    })
    if (!snapshot) reply(response, 404, { error: 'execution not found or expired' })
    else reply(response, 200, snapshot)
    return
  }

  if (match && request.method === 'DELETE') {
    const executionId = decodeURIComponent(match[1] ?? '')
    if (url.searchParams.get('dispose') === 'true') {
      const disposed = await disposeShellExecution(executionId)
      reply(response, disposed ? 200 : 404, { disposed })
    } else {
      const cancelled = cancelShellExecution(executionId)
      reply(response, cancelled ? 202 : 409, { cancelled })
    }
    return
  }

  reply(response, 404, { error: 'not found' })
}

async function readBody(request: IncomingMessage): Promise<RunRequest> {
  let raw = ''
  request.setEncoding('utf8')
  for await (const chunk of request) {
    raw += String(chunk)
    if (Buffer.byteLength(raw) > BODY_LIMIT_BYTES) throw new Error('request body is too large')
  }
  try {
    return JSON.parse(raw) as RunRequest
  } catch {
    throw new Error('request body is not JSON')
  }
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  response.end(text)
}

server.listen(PORT, () => {
  console.log(`[shell-runner] listening on ${PORT}, homes root ${HOMES_ROOT}`)
  const probeHome = join(HOMES_ROOT, '.probe')
  void runSandboxedShell({
    executionId: 'startup-probe',
    home: probeHome,
    cwd: probeHome,
    command: 'echo sandbox ok',
    timeoutMs: 15_000,
  })
    .then((outcome) => {
      sandboxReady = outcome.status === 'completed'
      if (sandboxReady) console.log('[shell-runner] sandbox builds — supervised run_shell is ready')
      else console.error(`[shell-runner] SANDBOX REFUSED: ${outcome.output.trim()}`)
    })
    .catch((error: unknown) => {
      sandboxReady = false
      console.error(`[shell-runner] SANDBOX REFUSED: ${error instanceof Error ? error.message : String(error)}`)
    })
})
