import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createConnection } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import {
  createGuacamoleBridge,
  guacamoleConnectQuery,
  type GuacamoleConnection,
} from '@braedonsaunders/appkit-remote-sessions/guacamole'
import type { RemoteTarget } from '@braedonsaunders/appkit-remote-sessions'

const httpPort = Number(process.env.PORT ?? 8090)
const bridgePort = Number(process.env.BUNKHOUSE_REMOTE_BRIDGE_PORT ?? 8091)
const token = process.env.BUNKHOUSE_REMOTE_GATEWAY_TOKEN?.trim() ?? ''
const publicWsUrl = process.env.BUNKHOUSE_REMOTE_GATEWAY_PUBLIC_URL?.trim() ?? `ws://127.0.0.1:${bridgePort}`
const guacdHost = process.env.GUACD_HOST?.trim() || 'guacd'
const guacdPort = Number(process.env.GUACD_PORT ?? 4822)
const cipherKey = process.env.BUNKHOUSE_REMOTE_CIPHER_KEY?.trim() ?? ''

if (!token || !cipherKey) throw new Error('BUNKHOUSE_REMOTE_GATEWAY_TOKEN and BUNKHOUSE_REMOTE_CIPHER_KEY are required.')

type Session = { id: string; target: RemoteTarget; openedAt: string }
const sessions = new Map<string, Session>()
type GraphicalRuntime = { display: string; directory: string; xvfb: ChildProcess; client: ChildProcess }
const graphicalRuntimes = new Map<string, GraphicalRuntime>()
let nextDisplay = 80

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

function authorized(request: IncomingMessage): boolean {
  const received = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? ''
  const left = Buffer.from(received)
  const right = Buffer.from(token)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > 2 * 1024 * 1024) throw new Error('Remote gateway request is too large.')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
}

function targetFrom(value: unknown): RemoteTarget {
  if (!value || typeof value !== 'object') throw new Error('Remote target is required.')
  const target = value as Partial<RemoteTarget>
  if (!target.id || !target.host || !target.protocol || !Number.isInteger(target.port)) throw new Error('Remote target is invalid.')
  return target as RemoteTarget
}

async function probe(host: string, port: number, timeoutMs = 3_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port })
    const finish = (error?: Error) => {
      socket.removeAllListeners()
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish())
    socket.once('timeout', () => finish(new Error(`Connection to ${host}:${port} timed out.`)))
    socket.once('error', (error) => finish(error))
  })
}

async function run(program: string, args: string[], timeoutMs = 120_000, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; output: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, LC_ALL: 'C.UTF-8' } })
    const chunks: Buffer[] = []
    let size = 0
    const collect = (chunk: Buffer) => {
      if (size >= 1024 * 1024) return
      const remaining = 1024 * 1024 - size
      chunks.push(chunk.subarray(0, remaining))
      size += Math.min(chunk.byteLength, remaining)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timeout)
      resolve({ ok: false, output: error.message, code: null })
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      resolve({ ok: code === 0, output: Buffer.concat(chunks).toString('utf8'), code })
    })
  })
}

async function runBytes(program: string, args: string[], env: NodeJS.ProcessEnv, limit = 8 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
    const chunks: Buffer[] = []
    const errors: Buffer[] = []
    let size = 0
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > limit) child.kill('SIGKILL')
      else chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0 && size <= limit) resolve(Buffer.concat(chunks))
      else reject(new Error(Buffer.concat(errors).toString('utf8').trim() || 'The graphical remote action failed.'))
    })
  })
}

async function runOnDisplay(display: string, program: string, args: string[]): Promise<void> {
  const result = await new Promise<{ code: number | null; error: string }>((resolve) => {
    const child = spawn(program, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, DISPLAY: display } })
    const errors: Buffer[] = []
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk))
    child.once('error', (error) => resolve({ code: null, error: error.message }))
    child.once('close', (code) => resolve({ code, error: Buffer.concat(errors).toString('utf8').trim() }))
  })
  if (result.code !== 0) throw new Error(result.error || `${program} exited with ${result.code ?? 'an error'}.`)
}

async function vncPasswordFile(directory: string, credential: string): Promise<string> {
  const passwordPath = join(directory, 'vnc-password')
  const encrypted = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn('tigervncpasswd', ['-f'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const output: Buffer[] = []
    const errors: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve(Buffer.concat(output)) : reject(new Error(Buffer.concat(errors).toString('utf8').trim() || 'VNC credential preparation failed.')))
    child.stdin.end(`${credential}\n`)
  })
  await writeFile(passwordPath, encrypted, { mode: 0o600 })
  return passwordPath
}

async function graphicalRuntime(session: Session, credential: string): Promise<GraphicalRuntime> {
  const existing = graphicalRuntimes.get(session.id)
  if (existing && existing.client.exitCode === null && existing.xvfb.exitCode === null) return existing
  if (existing) await stopGraphicalRuntime(session.id)

  const metadata = session.target.metadata ?? {}
  const username = typeof metadata.username === 'string' ? metadata.username : ''
  if (session.target.protocol === 'rdp' && !username) throw new Error('A username is required for RDP control.')

  const display = `:${nextDisplay++}`
  const directory = await mkdtemp(join(tmpdir(), 'bunkhouse-remote-screen-'))
  const env = { ...process.env, DISPLAY: display, LC_ALL: 'C.UTF-8' }
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], { stdio: 'ignore', env })
  await new Promise((resolve) => setTimeout(resolve, 250))
  if (xvfb.exitCode !== null) {
    await rm(directory, { recursive: true, force: true })
    throw new Error('The headless remote desktop display could not start.')
  }

  let client: ChildProcess
  if (session.target.protocol === 'rdp') {
    const domain = typeof metadata.domain === 'string' && metadata.domain ? [`/d:${metadata.domain}`] : []
    client = spawn('xfreerdp', [
      `/v:${session.target.host}:${session.target.port}`,
      `/u:${username}`,
      `/p:${credential}`,
      ...domain,
      '/cert:ignore',
      '/size:1440x900',
      '/network:auto',
      '/clipboard',
      '+auto-reconnect',
    ], { stdio: 'ignore', env })
  } else if (session.target.protocol === 'vnc') {
    const passwordPath = await vncPasswordFile(directory, credential)
    client = spawn('vncviewer', [
      '-PasswordFile', passwordPath,
      '-Shared',
      '-ViewOnly=0',
      '-RemoteResize=0',
      `${session.target.host}::${session.target.port}`,
    ], { stdio: 'ignore', env })
  } else {
    xvfb.kill('SIGKILL')
    await rm(directory, { recursive: true, force: true })
    throw new Error('Programmatic screen control is available for RDP and VNC sessions.')
  }
  const runtime = { display, directory, xvfb, client }
  graphicalRuntimes.set(session.id, runtime)
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  if (client.exitCode !== null) {
    await stopGraphicalRuntime(session.id)
    throw new Error('The programmatic remote desktop connection could not start. Check the address and credential.')
  }
  return runtime
}

async function stopGraphicalRuntime(sessionId: string): Promise<void> {
  const runtime = graphicalRuntimes.get(sessionId)
  if (!runtime) return
  graphicalRuntimes.delete(sessionId)
  runtime.client.kill('SIGTERM')
  runtime.xvfb.kill('SIGTERM')
  await rm(runtime.directory, { recursive: true, force: true })
}

async function graphicalAction(session: Session, credential: string, action: Record<string, unknown>): Promise<Buffer> {
  const runtime = await graphicalRuntime(session, credential)
  const name = String(action.action ?? '')
  if (name === 'click' || name === 'double_click') {
    const count = name === 'double_click' ? '2' : '1'
    await runOnDisplay(runtime.display, 'xdotool', ['mousemove', String(action.x), String(action.y), 'click', '--repeat', count, '--delay', '100', '1'])
  } else if (name === 'drag') {
    await runOnDisplay(runtime.display, 'xdotool', ['mousemove', String(action.from_x), String(action.from_y), 'mousedown', '1', 'mousemove', '--sync', String(action.to_x), String(action.to_y), 'mouseup', '1'])
  } else if (name === 'scroll') {
    const button = action.direction === 'up' ? '4' : '5'
    const amount = Math.max(1, Math.min(20, Number(action.amount ?? 3)))
    await runOnDisplay(runtime.display, 'xdotool', ['mousemove', String(action.x), String(action.y), 'click', '--repeat', String(amount), '--delay', '30', button])
  } else if (name === 'type') {
    await runOnDisplay(runtime.display, 'xdotool', ['type', '--clearmodifiers', '--delay', '10', String(action.text ?? '')])
  } else if (name === 'key') {
    const key = String(action.key ?? '')
      .replace(/CONTROL/gi, 'ctrl')
      .replace(/COMMAND|META/gi, 'super')
      .replace(/OPTION/gi, 'alt')
      .replaceAll(' ', '')
    await runOnDisplay(runtime.display, 'xdotool', ['key', '--clearmodifiers', key])
  } else if (name === 'wait') {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(10_000, Number(action.duration_ms ?? 500)))))
  } else if (name !== 'snapshot') {
    throw new Error(`Unsupported remote desktop action: ${name || 'missing action'}.`)
  }
  await new Promise((resolve) => setTimeout(resolve, 150))
  return runBytes('import', ['-display', runtime.display, '-window', 'root', 'png:-'], { ...process.env, DISPLAY: runtime.display, LC_ALL: 'C.UTF-8' })
}

async function remoteCommand(target: RemoteTarget, credential: string, command: string): Promise<{ ok: boolean; output: string; code: number | null }> {
  const metadata = target.metadata ?? {}
  const username = typeof metadata.username === 'string' && metadata.username ? metadata.username : null
  const kind = metadata.credentialKind === 'private_key' ? 'private_key' : 'password'
  if (!username) throw new Error('A username is required for remote terminal access.')
  if (target.protocol === 'ssh' || target.protocol === 'powershell-ssh') {
    const remote = target.protocol === 'powershell-ssh'
      ? `powershell.exe -NoLogo -NoProfile -NonInteractive -Command ${JSON.stringify(command)}`
      : command
    if (kind === 'password') {
      return run('sshpass', ['-p', credential, 'ssh', '-o', 'StrictHostKeyChecking=accept-new', '-p', String(target.port), `${username}@${target.host}`, remote])
    }
    const directory = await mkdtemp(join(tmpdir(), 'bunkhouse-remote-'))
    const keyPath = join(directory, 'key')
    try {
      await writeFile(keyPath, credential, { mode: 0o600 })
      return await run('ssh', ['-i', keyPath, '-o', 'StrictHostKeyChecking=accept-new', '-p', String(target.port), `${username}@${target.host}`, remote])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
  if (kind !== 'password') throw new Error(`${target.protocol.toUpperCase()} requires a password credential.`)
  if (target.protocol === 'winrm') {
    const domain = typeof metadata.domain === 'string' && metadata.domain ? `${metadata.domain}\\${username}` : username
    const program = [
      'import os,sys,winrm',
      "endpoint=f'http://{sys.argv[1]}:{sys.argv[2]}/wsman'",
      "session=winrm.Session(endpoint,auth=(sys.argv[3],os.environ['BUNKHOUSE_REMOTE_PASSWORD']),transport='ntlm')",
      'result=session.run_ps(sys.argv[4])',
      'sys.stdout.buffer.write(result.std_out)',
      'sys.stderr.buffer.write(result.std_err)',
      'raise SystemExit(result.status_code)',
    ].join(';')
    return run('python3', ['-c', program, target.host, String(target.port), domain, command], 120_000, { ...process.env, BUNKHOUSE_REMOTE_PASSWORD: credential })
  }
  if (target.protocol === 'telnet') {
    const script = [
      'set timeout 120',
      'log_user 1',
      'spawn telnet $env(BUNKHOUSE_REMOTE_HOST) $env(BUNKHOUSE_REMOTE_PORT)',
      'expect -re "(?i)(login|username):"',
      'send -- "$env(BUNKHOUSE_REMOTE_USER)\\r"',
      'expect -re "(?i)password:"',
      'send -- "$env(BUNKHOUSE_REMOTE_PASSWORD)\\r"',
      'expect -re {[$%#>] $}',
      'send -- "$env(BUNKHOUSE_REMOTE_COMMAND)\\r"',
      'expect -re {[$%#>] $}',
      'send -- "exit\\r"',
      'expect eof',
    ].join('; ')
    return run('expect', ['-c', script], 120_000, {
      ...process.env,
      BUNKHOUSE_REMOTE_HOST: target.host,
      BUNKHOUSE_REMOTE_PORT: String(target.port),
      BUNKHOUSE_REMOTE_USER: username,
      BUNKHOUSE_REMOTE_PASSWORD: credential,
      BUNKHOUSE_REMOTE_COMMAND: command,
    })
  }
  throw new Error(`${target.protocol.toUpperCase()} does not provide a terminal surface.`)
}

await createGuacamoleBridge({ port: bridgePort, guacdHost, guacdPort, cipherKey })

createServer(async (request, response) => {
  try {
    if (request.url === '/health') return json(response, 200, { ok: true })
    if (!authorized(request)) return json(response, 401, { error: 'Unauthorized.' })
    const url = new URL(request.url ?? '/', 'http://gateway.internal')
    const payload = request.method === 'GET' || request.method === 'DELETE' ? {} : await body(request)

    if (request.method === 'POST' && url.pathname === '/targets/test') {
      const target = targetFrom(payload.target)
      await probe(target.host, target.port)
      return json(response, 200, { ok: true })
    }
    if (request.method === 'POST' && url.pathname === '/sessions') {
      const id = String(payload.sessionId ?? '')
      if (!id) throw new Error('Session id is required.')
      const target = targetFrom(payload.target)
      await probe(target.host, target.port)
      sessions.set(id, { id, target, openedAt: new Date().toISOString() })
      return json(response, 201, { session: { id } })
    }
    const viewerMatch = url.pathname.match(/^\/sessions\/([^/]+)\/viewers$/)
    if (request.method === 'POST' && viewerMatch) {
      const id = decodeURIComponent(viewerMatch[1]!)
      const session = sessions.get(id)
      if (!session) throw new Error('Remote session is no longer open.')
      if (session.target.protocol !== 'rdp' && session.target.protocol !== 'vnc') throw new Error('This session uses the terminal surface.')
      const credential = typeof payload.credential === 'string' ? payload.credential : ''
      const metadata = session.target.metadata ?? {}
      const scope = payload.scope === 'control' ? 'control' : 'observe'
      const connection: GuacamoleConnection = {
        protocol: session.target.protocol,
        host: session.target.host,
        port: session.target.port,
        username: typeof metadata.username === 'string' ? metadata.username : null,
        domain: typeof metadata.domain === 'string' ? metadata.domain : null,
        password: credential,
        scope,
      }
      const expiresAt = typeof payload.expiresAt === 'string' ? payload.expiresAt : new Date(Date.now() + 600_000).toISOString()
      return json(response, 200, {
        kind: 'guacamole',
        bridgeWsUrl: publicWsUrl,
        connectQuery: guacamoleConnectQuery({ connection, cipherKey, sessionId: id, leaseId: String(payload.leaseId ?? id) }),
        expiresAt,
        width: 1440,
        height: 900,
      })
    }
    if (request.method === 'POST' && url.pathname === '/commands') {
      const target = targetFrom(payload.target)
      const credential = typeof payload.credential === 'string' ? payload.credential : ''
      const command = typeof payload.command === 'string' ? payload.command : ''
      if (!credential || !command) throw new Error('Credential and command are required.')
      const result = await remoteCommand(target, credential, command)
      return json(response, result.ok ? 200 : 422, { ok: result.ok, output: result.output, exitCode: result.code })
    }
    const actionMatch = url.pathname.match(/^\/sessions\/([^/]+)\/actions$/)
    if (request.method === 'POST' && actionMatch) {
      const id = decodeURIComponent(actionMatch[1]!)
      const session = sessions.get(id)
      if (!session) throw new Error('Remote session is no longer open.')
      const credential = typeof payload.credential === 'string' ? payload.credential : ''
      const action = payload.action && typeof payload.action === 'object' ? payload.action as Record<string, unknown> : null
      if (!credential || !action) throw new Error('Credential and action are required.')
      const frame = await graphicalAction(session, credential, action)
      return json(response, 200, { ok: true, mimeType: 'image/png', screenshotBase64: frame.toString('base64') })
    }
    const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/)
    if (request.method === 'DELETE' && sessionMatch) {
      const id = decodeURIComponent(sessionMatch[1]!)
      await stopGraphicalRuntime(id)
      sessions.delete(id)
      return json(response, 200, { ok: true })
    }
    return json(response, 404, { error: 'Not found.' })
  } catch (error) {
    return json(response, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}).listen(httpPort, '0.0.0.0', () => {
  console.log(`Bunkhouse remote gateway listening on ${httpPort}; browser bridge on ${bridgePort}.`)
})
