import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { insideRoot, runSandboxedShell, SHELL_TIMEOUT_MS } from '../src/lib/shell-sandbox'

/**
 * The one container allowed to build a sandbox.
 *
 * Bubblewrap needs CAP_SYS_ADMIN and both seccomp and AppArmor unconfined —
 * measured on the host, one combination at a time — and Docker Swarm has never
 * supported `security_opt` on a service, so nothing in the swarm stack can have
 * them. Rather than strip the confinement from `web`, `worker` and
 * `voice-agent` — the containers that run model-directed code and drive a
 * browser across the open web, on a host shared with other applications — the
 * privileges live here, in a process whose entire job is to run one sandboxed
 * command in one agent's home and hand back what it printed.
 *
 * It holds no database, no provider keys, no session secrets, and publishes no
 * port outside the internal network. What it can be talked into doing is
 * bounded by what it can be asked for:
 *
 *   - a bearer token, compared in constant time, or nothing happens;
 *   - a home directory that must resolve INSIDE the configured homes root, so
 *     a caller cannot ask for the host's filesystem to be made writable;
 *   - a working directory that must resolve inside that same home;
 *   - one command, one timeout, output capped, then the process is gone.
 *
 * Deliberately not part of the swarm stack, and deliberately not sharing its
 * image env: it is deployed on its own so the security options apply, and so
 * that everything it does not need, it does not have.
 */

const PORT = Number(process.env.PORT ?? 8080)
const TOKEN = process.env.BUNKHOUSE_SHELL_TOKEN ?? ''
const HOMES_ROOT = process.env.BUNKHOUSE_AGENT_HOMES ?? '/data/agent-homes'

if (!TOKEN) {
  console.error('[shell-runner] BUNKHOUSE_SHELL_TOKEN is not set; refusing to start unauthenticated.')
  process.exit(1)
}

/** Constant time, and length-safe — `timingSafeEqual` throws on a mismatch. */
function tokenMatches(offered: string): boolean {
  const a = Buffer.from(offered)
  const b = Buffer.from(TOKEN)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

type RunRequest = { home?: unknown; cwd?: unknown; command?: unknown }

const server = createServer((request, response) => {
  const reply = (status: number, body: unknown) => {
    const text = JSON.stringify(body)
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    response.end(text)
  }

  if (request.method === 'GET' && request.url === '/health') return reply(200, { ok: true, homesRoot: HOMES_ROOT })
  if (request.method !== 'POST' || request.url !== '/run') return reply(404, { error: 'not found' })

  const offered = (request.headers.authorization ?? '').replace(/^Bearer /i, '')
  if (!tokenMatches(offered)) return reply(401, { error: 'unauthorized' })

  let raw = ''
  request.setEncoding('utf8')
  request.on('data', (chunk: string) => {
    raw += chunk
    // A command line and a path; anything of size is not one of those.
    if (raw.length > 256 * 1024) request.destroy()
  })
  request.on('end', () => {
    void (async () => {
      let body: RunRequest
      try {
        body = JSON.parse(raw) as RunRequest
      } catch {
        return reply(400, { error: 'body is not JSON' })
      }
      const { home, cwd, command } = body
      if (typeof home !== 'string' || typeof cwd !== 'string' || typeof command !== 'string') {
        return reply(400, { error: 'home, cwd and command are all required strings' })
      }
      // The whole point of the boundary: this process can write anywhere the
      // sandbox is told it may, so what it is told is checked rather than
      // trusted. A home outside the root, or a cwd outside that home, is a
      // request to make something else writable and is refused.
      if (!insideRoot(HOMES_ROOT, home)) {
        return reply(403, { error: 'that home is not inside this runner’s workspace root' })
      }
      if (!insideRoot(home, cwd)) {
        return reply(403, { error: 'that working directory is not inside that home' })
      }
      try {
        const outcome = await runSandboxedShell({ home, cwd, command, timeoutMs: SHELL_TIMEOUT_MS })
        return reply(200, outcome)
      } catch (error) {
        // A sandbox that cannot be built is the failure this service exists to
        // prevent, so it says so plainly rather than returning an empty result
        // an agent would read as "the command did nothing".
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[shell-runner] ${message}`)
        return reply(200, {
          status: 'failed',
          exitCode: null,
          output: `The workspace sandbox could not be built: ${message}`,
        })
      }
    })()
  })
})

server.listen(PORT, () => {
  console.log(`[shell-runner] listening on ${PORT}, homes root ${HOMES_ROOT}`)
  // Prove the privileges actually landed, at boot, in the logs — rather than
  // discovering it the next time an agent tries to do some work.
  void runSandboxedShell({
    home: join(HOMES_ROOT, '.probe'),
    cwd: join(HOMES_ROOT, '.probe'),
    command: 'echo sandbox ok',
    timeoutMs: 15_000,
  })
    .then((outcome) => {
      if (outcome.status === 'completed') console.log('[shell-runner] sandbox builds — run_shell works here')
      else console.error(`[shell-runner] SANDBOX REFUSED: ${outcome.output.trim()}`)
    })
    .catch((error: unknown) => {
      console.error(`[shell-runner] SANDBOX REFUSED: ${error instanceof Error ? error.message : String(error)}`)
    })
})
