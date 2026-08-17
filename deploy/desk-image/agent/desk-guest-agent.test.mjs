/**
 * Self-test for the in-guest desk agent, runnable on ANY machine — there is no
 * X server here and there must not need to be one.
 *
 * What it proves:
 *   1. the machine tier still works (ping, exec, capabilities);
 *   2. every desktop-tier handler fails FAST and LOUDLY without a screen,
 *      rather than hanging the host or returning a silent success;
 *   3. screen-start with no Xvfb installed reports why, within its deadline;
 *   4. wire-level validation rejects malformed input before it reaches argv.
 *
 * Run it with:  node deploy/desk-image/agent/desk-guest-agent.test.mjs
 */

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT = join(HERE, 'desk-guest-agent.mjs')

/** Every desktop call must settle inside this; a hang is the failure we fear. */
const CALL_TIMEOUT_MS = 45_000

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    process.stdout.write(`  ok   ${name}\n`)
  } else {
    failures += 1
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`)
  }
}

function encode(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.byteLength)
  frame.writeUInt32BE(body.byteLength, 0)
  body.copy(frame, 4)
  return frame
}

function createClient(socketPath) {
  const socket = connect(socketPath)
  const pending = new Map()
  let buffered = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk])
    while (buffered.byteLength >= 4) {
      const length = buffered.readUInt32BE(0)
      if (buffered.byteLength < 4 + length) break
      const message = JSON.parse(buffered.subarray(4, 4 + length).toString('utf8'))
      buffered = buffered.subarray(4 + length)
      const settle = pending.get(message.id)
      if (settle) {
        pending.delete(message.id)
        settle(message)
      }
    }
  })
  let nextId = 0
  return {
    ready: new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    }),
    call(command) {
      const id = `t${(nextId += 1)}`
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${command.op} never answered within ${CALL_TIMEOUT_MS}ms`)),
          CALL_TIMEOUT_MS,
        )
        pending.set(id, (message) => {
          clearTimeout(timer)
          resolve(message)
        })
        socket.write(encode({ ...command, id }))
      })
    },
    close() {
      socket.destroy()
    },
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'desk-agent-test-'))
  const socketPath = join(dir, 'agent.sock')
  const agent = spawn(process.execPath, [AGENT], {
    env: {
      ...process.env,
      DESK_GUEST_AGENT_SOCKET: socketPath,
      // Point PATH at an empty directory so Xvfb/xdotool/import cannot be
      // found even on a developer machine that happens to have them.
      PATH: dir,
      DISPLAY: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let agentLog = ''
  agent.stderr.on('data', (chunk) => {
    agentLog += chunk.toString('utf8')
  })

  // Wait for the listening line before connecting.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`agent never listened:\n${agentLog}`)), 10_000)
    const poll = setInterval(() => {
      if (agentLog.includes('listening on')) {
        clearInterval(poll)
        clearTimeout(timer)
        resolve()
      }
    }, 50)
    agent.once('exit', (code) => {
      clearInterval(poll)
      clearTimeout(timer)
      reject(new Error(`agent exited with ${code}:\n${agentLog}`))
    })
  })

  const client = createClient(socketPath)
  await client.ready

  process.stdout.write('machine tier\n')
  const ping = await client.call({ op: 'ping' })
  check('ping answers', ping.ok === true && ping.result.pong === true, JSON.stringify(ping))

  const capabilities = await client.call({ op: 'capabilities' })
  check(
    'capabilities keeps its declared shape',
    capabilities.ok === true && typeof capabilities.result.virtioGpu === 'boolean',
    JSON.stringify(capabilities),
  )

  const exec = await client.call({ op: 'exec', command: process.execPath, args: ['-e', 'process.stdout.write("hi")'] })
  check(
    'exec still runs a command',
    exec.ok === true && exec.result.stdout === 'hi' && exec.result.exitCode === 0,
    JSON.stringify(exec),
  )

  process.stdout.write('desktop tier without a screen\n')
  const noScreen = [
    { op: 'observe' },
    { op: 'input', input: { type: 'click', x: 10, y: 10, button: 'left' } },
    { op: 'a11y-invoke', nodeId: '0/1', action: 'click' },
    { op: 'launch', appId: 'xterm' },
    { op: 'clipboard-read' },
    { op: 'clipboard-write', text: 'hello' },
    { op: 'frames-start', fps: 5, width: 1280, height: 900 },
    { op: 'video-start', fps: 30, width: 1280, height: 900 },
    { op: 'handover-begin', ttlMs: 60_000, scope: 'view' },
  ]
  for (const command of noScreen) {
    const response = await client.call(command)
    check(
      `${command.op} refuses with a clear message`,
      response.ok === false && /no screen is running/.test(response.error),
      JSON.stringify(response),
    )
  }

  // The two stops are idempotent even with nothing running.
  for (const op of ['frames-stop', 'video-stop', 'screen-stop', 'handover-end']) {
    const response = await client.call({ op })
    check(`${op} is idempotent`, response.ok === true, JSON.stringify(response))
  }

  process.stdout.write('validation\n')
  const badFormat = await client.call({ op: 'frames-start', fps: 5, width: 1280, height: 900, format: 'webp' })
  check(
    'frames-start rejects a format nobody can encode',
    badFormat.ok === false && /format must be png or jpeg/.test(badFormat.error),
    JSON.stringify(badFormat),
  )

  const badScreen = await client.call({ op: 'screen-start', width: 4, height: 4 })
  check(
    'screen-start rejects an absurd size before spawning anything',
    badScreen.ok === false && /width must be an integer/.test(badScreen.error),
    JSON.stringify(badScreen),
  )

  process.stdout.write('screen-start with no X server present\n')
  const started = Date.now()
  const screen = await client.call({ op: 'screen-start', width: 1280, height: 900 })
  const elapsed = Date.now() - started
  check(
    'screen-start fails rather than hanging',
    screen.ok === false && /could not start the screen/.test(screen.error),
    JSON.stringify(screen),
  )
  check(`screen-start failed inside its deadline (${elapsed}ms)`, elapsed < CALL_TIMEOUT_MS)

  client.close()
  agent.kill('SIGTERM')
  await new Promise((resolve) => agent.once('exit', resolve))
  rmSync(dir, { recursive: true, force: true })

  if (failures > 0) {
    process.stdout.write(`\n${failures} check(s) failed\n\nagent log:\n${agentLog}\n`)
    process.exit(1)
  }
  process.stdout.write('\nall checks passed\n')
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`)
  process.exit(1)
})
