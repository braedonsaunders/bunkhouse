/**
 * The in-guest desk agent: PID 1's helper inside the per-agent microVM.
 *
 * It speaks the framed JSON protocol (4-byte big-endian length prefix + UTF-8
 * JSON body) that the host's desk-runner drives over vsock port 5252. A socat
 * unit (desk-vsock-bridge.service) bridges VSOCK-LISTEN:5252 to the UNIX socket
 * this process listens on at /run/desk-guest-agent.sock, so this file never has
 * to know about vsock addressing at all — it is a plain UNIX-socket server.
 *
 * This is the ONLY new attack surface in the desk design (spec §5.1, §8): a bug
 * here is a sandbox escape. It is deliberately small and dependency-free — only
 * node: built-ins plus the vendored, dependency-free @appkit/desk protocol core
 * in ./appkit-desk/. The core owns all contact with the wire (bounded frame
 * decoding, strict parsing, a closed dispatch switch); the handlers below own
 * all contact with the guest OS. A handler that throws becomes a clean error
 * response to the host — never a crash.
 *
 * TIER NOTE: this is the HEADLESS base image. Everything screen-related
 * (screenStart, screenStop, observe, input, a11yInvoke, launch, clipboardRead,
 * clipboardWrite, framesStart, framesStop, handoverBegin, handoverEnd) throws
 * "desktop tier is not enabled in this base image". Phase 5 (spec §7) replaces
 * those stubs with real wlroots/AT-SPI implementations in the screen-tier image
 * that bakes in the compositor; until then the exec/job surface is the whole of
 * a working desk.
 */

import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'

import { runGuestAgent } from './appkit-desk/guest-agent.js'

// The systemd unit runs with no environment override, so this is the real path
// the socat vsock bridge connects to. The env hook exists only so the agent can
// be exercised over a temp socket in a test harness without a microVM.
const SOCKET_PATH = process.env.DESK_GUEST_AGENT_SOCKET ?? '/run/desk-guest-agent.sock'

/** Cap each captured stream at 1 MiB, matching the host's expectations. */
const OUTPUT_CAP_BYTES = 1024 * 1024

const DESKTOP_TIER_DISABLED = 'desktop tier is not enabled in this base image'

function log(...parts) {
  process.stderr.write(`[desk-guest-agent] ${parts.join(' ')}\n`)
}

function desktopTierStub() {
  throw new Error(DESKTOP_TIER_DISABLED)
}

/**
 * Build the handler set for one connection. `sendEvent` is the RunningGuestAgent
 * push channel, wired here so a detached job can emit its `job-exit` event to the
 * host when the child finally exits.
 */
function createHandlers(getSendEvent) {
  /** jobId -> ChildProcess, for jobSignal and exit reporting. */
  const jobs = new Map()

  return {
    /**
     * Run a command to completion. execFile (no shell) with the caller's cwd/env,
     * a hard timeout that SIGKILLs the process, and each stream capped at 1 MiB.
     */
    exec({ command, args, cwd, env, timeoutMs }) {
      return new Promise((resolve) => {
        const child = execFile(
          command,
          args,
          {
            ...(cwd ? { cwd } : {}),
            ...(env ? { env } : {}),
            ...(timeoutMs ? { timeout: timeoutMs } : {}),
            killSignal: 'SIGKILL',
            maxBuffer: OUTPUT_CAP_BYTES,
            encoding: 'buffer',
            windowsHide: true,
          },
          (error, stdoutBuf, stderrBuf) => {
            const stdout = clampBuffer(stdoutBuf)
            const stderr = clampBuffer(stderrBuf)
            // A spawn failure (the binary could not be run) surfaces here as a
            // string error.code — ENOENT/EACCES — rather than a numeric exit
            // status. Report it the way a shell would: 127 for not-found, 126
            // for not-executable, with the message in stderr so the host has
            // something to show. A normal non-zero exit leaves error.code as a
            // number and we read the real status off the child below.
            if (error != null && typeof error.code === 'string' && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
              resolve({
                exitCode: error.code === 'EACCES' ? 126 : 127,
                signal: null,
                stdout: stdout.text,
                stderr: stderr.text || String(error.message ?? error),
                truncated: stdout.truncated || stderr.truncated,
              })
              return
            }
            const exitCode = typeof child.exitCode === 'number' ? child.exitCode : null
            const signal = child.signalCode ?? null
            const truncated =
              stdout.truncated ||
              stderr.truncated ||
              (error != null && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
            resolve({
              exitCode: signal != null ? null : exitCode,
              signal,
              stdout: stdout.text,
              stderr: stderr.text,
              truncated,
            })
          },
        )
        // Belt and suspenders: if the child emits 'error' before the callback
        // fires, settle the call so the host never hangs. resolve() after the
        // callback has already settled is a no-op.
        child.on('error', (error) => {
          resolve({
            exitCode: 127,
            signal: null,
            stdout: '',
            stderr: String(error && error.message ? error.message : error),
            truncated: false,
          })
        })
      })
    },

    /**
     * Start a detached background job. We keep the child so jobSignal can reach
     * it, and emit a `job-exit` guest event when it finally exits.
     */
    async jobStart({ command, args, cwd, env }) {
      const jobId = randomUUID()
      const child = spawn(command, args, {
        ...(cwd ? { cwd } : {}),
        ...(env ? { env } : {}),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      jobs.set(jobId, child)
      child.once('exit', (code, signal) => {
        jobs.delete(jobId)
        const sendEvent = getSendEvent()
        if (sendEvent) {
          sendEvent({
            event: 'job-exit',
            jobId,
            exitCode: typeof code === 'number' ? code : null,
            signal: signal ?? null,
          })
        }
      })
      child.once('error', (error) => {
        jobs.delete(jobId)
        log(`job ${jobId} failed to start:`, String(error && error.message ? error.message : error))
        const sendEvent = getSendEvent()
        if (sendEvent) sendEvent({ event: 'job-exit', jobId, exitCode: null, signal: null })
      })
      // Let the guest continue running independent of this process's lifetime.
      child.unref()
      return { jobId }
    },

    async jobSignal({ jobId, signal }) {
      const child = jobs.get(jobId)
      if (!child) throw new Error(`no such job: ${jobId}`)
      child.kill(signal)
    },

    async capabilities() {
      return { virtioGpu: false }
    },

    // --- desktop tier: stubbed until Phase 5 (spec §7) ---------------------
    async screenStart() {
      desktopTierStub()
    },
    async screenStop() {
      desktopTierStub()
    },
    async observe() {
      desktopTierStub()
    },
    async input() {
      desktopTierStub()
    },
    async a11yInvoke() {
      desktopTierStub()
    },
    async launch() {
      desktopTierStub()
    },
    async clipboardRead() {
      desktopTierStub()
    },
    async clipboardWrite() {
      desktopTierStub()
    },
    async framesStart() {
      desktopTierStub()
    },
    async framesStop() {
      desktopTierStub()
    },
    async handoverBegin() {
      desktopTierStub()
    },
    async handoverEnd() {
      desktopTierStub()
    },
  }
}

/** Clamp a captured Buffer to OUTPUT_CAP_BYTES, decoding what survives as UTF-8. */
function clampBuffer(buf) {
  if (!buf || buf.length === 0) return { text: '', truncated: false }
  if (buf.length <= OUTPUT_CAP_BYTES) return { text: buf.toString('utf8'), truncated: false }
  return { text: buf.subarray(0, OUTPUT_CAP_BYTES).toString('utf8'), truncated: true }
}

function main() {
  // A stale socket from a previous run would make listen() fail with EADDRINUSE.
  if (existsSync(SOCKET_PATH)) {
    try {
      unlinkSync(SOCKET_PATH)
    } catch (error) {
      log('could not remove stale socket:', String(error && error.message ? error.message : error))
    }
  }

  const server = createServer((connection) => {
    connection.on('error', (error) => {
      log('connection error:', String(error && error.message ? error.message : error))
    })
    let running = null
    // Late-binding closure: jobStart may fire an event after the handshake, so
    // it reads `running.sendEvent` at emit time rather than capturing early.
    const handlers = createHandlers(() => (running ? running.sendEvent : null))
    running = runGuestAgent({ stream: connection, handlers })
  })

  server.on('error', (error) => {
    // A listen-level failure is fatal; anything else is logged and survived.
    log('server error:', String(error && error.message ? error.message : error))
    process.exitCode = 1
  })

  server.listen(SOCKET_PATH, () => {
    log(`listening on ${SOCKET_PATH}`)
  })

  const shutdown = (sig) => {
    log(`received ${sig}, shutting down`)
    server.close(() => {
      if (existsSync(SOCKET_PATH)) {
        try {
          unlinkSync(SOCKET_PATH)
        } catch {
          // best effort
        }
      }
      process.exit(0)
    })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main()
