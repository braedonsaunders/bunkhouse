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
 * response to the host — never a crash. NOTHING that arrives on the wire is
 * ever handed to a shell: every external program is run with execFile/spawn and
 * an argument array, and every wire field is validated before it gets there.
 *
 * TIERS
 * -----
 * MACHINE TIER (exec, jobStart, jobSignal, capabilities): plain child processes.
 * Unchanged since Phase 1 and load-bearing on its own — a headless desk is a
 * working desk.
 *
 * DESKTOP TIER (Phase 5/6, spec §7): implemented, on X11.
 *
 *   Session      `Xvfb :99` at exactly the requested size, then a session bus
 *                (dbus-launch) and `xfce4-session`. XFCE 4.18 is X11-native and
 *                §3.9 chose a CONVENTIONAL desktop deliberately: these models
 *                were trained on screenshots of ordinary desktops and drive
 *                them measurably better than a tiling compositor. There is no
 *                XWayland here and none is needed — XWayland exists to run X11
 *                clients under a WAYLAND compositor, the reverse of this stack;
 *                an X11 session runs X11 apps natively.
 *
 *   Perception   PIXELS-PRIMARY with OPPORTUNISTIC AT-SPI (§3.10). observe()
 *                always returns a real screenshot of :99. It additionally tries
 *                to read the focused application's AT-SPI tree through the
 *                bundled atspi-dump.py helper; if the helper, the bus, or the
 *                tree is unavailable it returns `a11y: null` AND STILL RETURNS
 *                THE PNG. Accessibility never gates perception, because a stale
 *                or missing tree must never stop the agent from seeing.
 *
 *   Coordinates  1:1 with observe(), no scaling anywhere. See the COORDINATE
 *                CONTRACT comment above input().
 *
 *   Capture      framesStart() captures at the requested fps but only EMITS
 *                frames whose bytes changed (SHA-256 over the PNG), with a
 *                keepalive so a late subscriber is never left blank. A still
 *                screen costs one hash per tick and no transport (§3.13).
 *
 *   Handover     x11vnc bound to 127.0.0.1 only, with a guest-side TTL timer
 *                that kills it even if handoverEnd never arrives (§3.14). The
 *                masking rules are enforced HOST-side by @appkit/desk; the
 *                guest simply keeps no record of handover input at all.
 */

import { Buffer } from 'node:buffer'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, unlinkSync } from 'node:fs'
import { createServer, connect as netConnect } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runGuestAgent } from './appkit-desk/guest-agent.js'

// The systemd unit runs with no environment override, so this is the real path
// the socat vsock bridge connects to. The env hook exists only so the agent can
// be exercised over a temp socket in a test harness without a microVM.
const SOCKET_PATH = process.env.DESK_GUEST_AGENT_SOCKET ?? '/run/desk-guest-agent.sock'

/** Cap each captured stream at 1 MiB, matching the host's expectations. */
const OUTPUT_CAP_BYTES = 1024 * 1024

/** Where this file lives — /opt/desk-agent in the image, the repo in a test. */
const AGENT_DIR = dirname(fileURLToPath(import.meta.url))

/** The AT-SPI reader that ships beside this file (see atspi-dump.py). */
const ATSPI_DUMP = join(AGENT_DIR, 'atspi-dump.py')

// --- the X11 session --------------------------------------------------------

/** One desk, one display. :99 is conventional for a headless X server. */
const DISPLAY = ':99'
const X_DISPLAY_NUMBER = 99
const X_SOCKET = `/tmp/.X11-unix/X${X_DISPLAY_NUMBER}`
const X_LOCK = `/tmp/.X${X_DISPLAY_NUMBER}-lock`

/** Xvfb must answer xdpyinfo within this long or screenStart fails loudly. */
const DISPLAY_READY_TIMEOUT_MS = 20_000
/** How long to wait for xfwm4 (or whatever xfce4-session starts) to own the root. */
const WM_READY_TIMEOUT_MS = 12_000
/** SIGTERM, then this long, then SIGKILL. */
const TERMINATE_GRACE_MS = 3_000

/** Screenshots and AT-SPI dumps are bounded in both time and bytes. */
const SCREENSHOT_TIMEOUT_MS = 10_000
const SCREENSHOT_CAP_BYTES = 32 * 1024 * 1024
const ATSPI_TIMEOUT_MS = 5_000
const ATSPI_CAP_BYTES = 8 * 1024 * 1024
const ATSPI_MAX_DEPTH = 12
const ATSPI_MAX_NODES = 2000

/** xdotool calls are short; anything slower than this is a stuck server. */
const XDOTOOL_TIMEOUT_MS = 10_000
/** `xdotool type` delay per character, and the cap on how much we will type. */
const TYPE_DELAY_MS = 12
const TYPE_MAX_CHARS = 8192
/** One wheel click is worth this many pixels of the scroll delta. */
const SCROLL_PIXELS_PER_CLICK = 40
const SCROLL_MAX_CLICKS = 25
/** Intermediate motion steps in a drag, so drag-aware apps see movement. */
const DRAG_STEPS = 8

/** Clipboard payloads are bounded on both directions. */
const CLIPBOARD_CAP_BYTES = 1024 * 1024
const CLIPBOARD_TIMEOUT_MS = 5_000

/** Frame capture bounds. */
const FRAMES_MIN_FPS = 1
const FRAMES_MAX_FPS = 30
/** Re-emit an unchanged frame this often so a late subscriber is not blank. */
const FRAMES_KEEPALIVE_MS = 5_000
/** The protocol's frame limit is 8 MiB; refuse to even try above this. */
const FRAME_PAYLOAD_CAP_BYTES = 6 * 1024 * 1024

/** Handover bounds: at least a second, at most four hours. */
const HANDOVER_MIN_TTL_MS = 1_000
const HANDOVER_MAX_TTL_MS = 4 * 60 * 60 * 1000
const HANDOVER_PORT = 5900
const HANDOVER_READY_TIMEOUT_MS = 10_000

/** Screen geometry bounds; the protocol caps dimensions at 16384 too. */
const MIN_SCREEN_PX = 64
const MAX_SCREEN_PX = 16_384

function log(...parts) {
  process.stderr.write(`[desk-guest-agent] ${parts.join(' ')}\n`)
}

function errorText(error) {
  return String(error && error.message ? error.message : error)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Clamp a captured Buffer to OUTPUT_CAP_BYTES, decoding what survives as UTF-8. */
function clampBuffer(buf) {
  if (!buf || buf.length === 0) return { text: '', truncated: false }
  if (buf.length <= OUTPUT_CAP_BYTES) return { text: buf.toString('utf8'), truncated: false }
  return { text: buf.subarray(0, OUTPUT_CAP_BYTES).toString('utf8'), truncated: true }
}

// --- wire-field validation --------------------------------------------------
//
// Everything below runs on values that came off the socket. The protocol core
// has already type-checked them; these checks are the second half of the same
// job — range and shape — done here because these values reach argv.

function requireInteger(value, field, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`)
  }
  return value
}

function requireText(value, field, maxLength) {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  if (value.length > maxLength) {
    throw new Error(`${field} is ${value.length} characters; the limit is ${maxLength}`)
  }
  return value
}

/**
 * A key combo as xdotool understands it: `ctrl+shift+t`, `Return`, `F5`. The
 * character class is deliberately narrow — this string becomes an argv entry,
 * and a combo has no business containing anything else.
 */
const KEY_COMBO_PATTERN = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/

/**
 * A launchable program: a bare command name resolved through PATH, or an
 * absolute path. No spaces, no shell metacharacters, no relative traversal.
 */
const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
const ABSOLUTE_PATH_PATTERN = /^\/[A-Za-z0-9._+\-/]+$/

function requireLaunchable(appId) {
  requireText(appId, 'appId', 512)
  if (appId.includes('..')) throw new Error('appId must not contain ".."')
  if (appId.startsWith('/')) {
    if (!ABSOLUTE_PATH_PATTERN.test(appId)) throw new Error(`appId is not a usable path: ${appId}`)
    return appId
  }
  if (!COMMAND_NAME_PATTERN.test(appId)) throw new Error(`appId is not a usable command name: ${appId}`)
  return appId
}

// --- running external programs ---------------------------------------------

/**
 * Run one guest binary with an argument array — never a shell — under a hard
 * timeout, and turn every failure into a message an operator can act on.
 *
 * `allowFailure` is for the handful of tools that use a non-zero exit as an
 * ordinary answer (xclip on an empty selection, xdotool with no focus). Nothing
 * is ever swallowed: the caller gets the failure and decides.
 */
function runTool(bin, args, options = {}) {
  const {
    timeoutMs = 5_000,
    env = null,
    binary = false,
    maxBuffer = OUTPUT_CAP_BYTES,
    allowFailure = false,
  } = options
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer,
        encoding: binary ? 'buffer' : 'utf8',
        ...(env ? { env } : {}),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const stderrText = binary
          ? (stderr && stderr.length ? stderr.toString('utf8') : '')
          : String(stderr ?? '')
        if (error && !allowFailure) {
          const why = error.killed
            ? `timed out after ${timeoutMs}ms`
            : error.code === 'ENOENT'
              ? 'is not installed in this image'
              : `exited with ${error.code ?? 'an error'}`
          const detail = stderrText.trim().slice(0, 512)
          reject(new Error(`${bin} ${why}${detail ? `: ${detail}` : ''}`))
          return
        }
        resolve({ stdout, stderr: stderrText, failed: error != null, error: error ?? null })
      },
    )
  })
}

/**
 * Spawn a long-lived session process and keep a tail of its stderr, so a
 * failure to start can be reported with the reason the program gave rather
 * than a bare exit code.
 */
function spawnTracked(name, bin, args, env) {
  const child = spawn(bin, args, { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  const tracked = { name, child, stderrTail: '', exited: false }
  child.stderr.on('data', (chunk) => {
    tracked.stderrTail = (tracked.stderrTail + chunk.toString('utf8')).slice(-2048)
  })
  child.on('error', (error) => {
    tracked.exited = true
    tracked.stderrTail = `${tracked.stderrTail}\nspawn failed: ${errorText(error)}`.slice(-2048)
    log(`${name} failed to spawn:`, errorText(error))
  })
  child.on('exit', (code, signal) => {
    tracked.exited = true
    log(`${name} exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`)
  })
  return tracked
}

/** SIGTERM, wait out the grace, then SIGKILL. Resolves when the child is gone. */
function terminate(tracked, graceMs = TERMINATE_GRACE_MS) {
  const { child } = tracked
  if (tracked.exited || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    let killTimer = null
    const finish = () => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      resolve()
    }
    child.once('exit', finish)
    try {
      child.kill('SIGTERM')
    } catch (error) {
      log(`could not SIGTERM ${tracked.name}:`, errorText(error))
      finish()
      return
    }
    killTimer = setTimeout(() => {
      log(`${tracked.name} ignored SIGTERM after ${graceMs}ms; sending SIGKILL`)
      try {
        child.kill('SIGKILL')
      } catch (error) {
        log(`could not SIGKILL ${tracked.name}:`, errorText(error))
      }
      finish()
    }, graceMs)
  })
}

/** Read the width and height straight out of a PNG's IHDR. */
function pngDimensions(buf) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!Buffer.isBuffer(buf) || buf.length < 24 || !buf.subarray(0, 8).equals(signature)) {
    throw new Error('the screenshot tool did not return a PNG')
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

// --- the desktop tier -------------------------------------------------------

/**
 * The screen belongs to the MACHINE, not to a connection: the host may
 * reconnect over vsock without the desk losing its display. So this state is a
 * module-level singleton, while the machine tier's job table stays per
 * connection exactly as it was.
 */
function createDesktopTier() {
  /**
   * `{ width, height, children: Tracked[], sessionEnv, dbusPid }` while a
   * screen is up, otherwise null.
   */
  let screen = null
  /** `{ timer, seq, lastHash, lastEmitAt, sendEvent, fps, stopped }` or null. */
  let frames = null
  /** `{ tracked, timer, url, scope }` or null. */
  let handover = null
  /**
   * The pid behind the window that was focused at the last observe(). a11y node
   * ids only mean anything against that application, so a11yInvoke re-walks
   * from it rather than from whatever happens to be active a moment later.
   */
  let lastFocusedPid = null

  /** Serializes screenStart/screenStop so two hosts cannot race the session. */
  let lifecycle = Promise.resolve()

  function requireScreen() {
    if (!screen) throw new Error('no screen is running; call screen-start first')
    return screen
  }

  /**
   * The environment every desktop child and every tool call inherits.
   *
   * The accessibility variables are what make the OPPORTUNISTIC half of §3.10
   * possible: GTK loads its ATK bridge only when GTK_MODULES asks for it and
   * NO_AT_BRIDGE is unset, and Qt exposes its tree only when QT_ACCESSIBILITY
   * is on. Setting them costs nothing when nothing reads the tree.
   */
  function baseEnv(extra = {}) {
    const env = { ...process.env }
    delete env.NO_AT_BRIDGE
    return {
      ...env,
      DISPLAY,
      HOME: process.env.HOME ?? '/root',
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '/run/desk-agent',
      XDG_CURRENT_DESKTOP: 'XFCE',
      XDG_SESSION_TYPE: 'x11',
      GTK_MODULES: 'gail:atk-bridge',
      QT_ACCESSIBILITY: '1',
      QT_LINUX_ACCESSIBILITY_ALWAYS_ON: '1',
      GNOME_ACCESSIBILITY: '1',
      ...(screen ? screen.sessionEnv : {}),
      ...extra,
    }
  }

  /** Wait until the X server actually answers, or fail with why it did not. */
  async function waitForDisplay(xvfb) {
    const deadline = Date.now() + DISPLAY_READY_TIMEOUT_MS
    let lastReason = 'no attempt was made'
    while (Date.now() < deadline) {
      if (xvfb.exited) {
        throw new Error(
          `Xvfb exited before ${DISPLAY} came up: ${xvfb.stderrTail.trim().slice(0, 512) || 'no output'}`,
        )
      }
      if (existsSync(X_SOCKET)) {
        try {
          await runTool('xdpyinfo', ['-display', DISPLAY], {
            timeoutMs: 4_000,
            env: { ...process.env, DISPLAY },
          })
          return
        } catch (error) {
          lastReason = errorText(error)
        }
      } else {
        lastReason = `${X_SOCKET} has not appeared`
      }
      await sleep(150)
    }
    throw new Error(
      `Xvfb did not answer on ${DISPLAY} within ${DISPLAY_READY_TIMEOUT_MS}ms: ${lastReason}`,
    )
  }

  /**
   * Start the session bus. `dbus-launch` prints its address and pid on stdout
   * in a shell-dependent syntax, so parse it with a regex that copes with all
   * of them rather than trusting one shape.
   */
  async function startSessionBus() {
    const { stdout } = await runTool('dbus-launch', [], {
      timeoutMs: 10_000,
      env: { ...process.env, DISPLAY },
    })
    const address = /DBUS_SESSION_BUS_ADDRESS=['"]?([^'";\n]+)/.exec(stdout)
    const pid = /DBUS_SESSION_BUS_PID=['"]?(\d+)/.exec(stdout)
    if (!address) {
      throw new Error(`dbus-launch printed no DBUS_SESSION_BUS_ADDRESS: ${stdout.trim().slice(0, 256)}`)
    }
    return {
      address: address[1],
      pid: pid ? Number(pid[1]) : null,
    }
  }

  /** The at-spi bus launcher moved between /usr/libexec and /usr/lib over time. */
  function findAtSpiLauncher() {
    const candidates = [
      '/usr/libexec/at-spi-bus-launcher',
      '/usr/lib/at-spi2-core/at-spi-bus-launcher',
      '/usr/lib/x86_64-linux-gnu/at-spi2-core/at-spi-bus-launcher',
    ]
    return candidates.find((candidate) => existsSync(candidate)) ?? null
  }

  /** True once something owns _NET_SUPPORTING_WM_CHECK — i.e. a WM is running. */
  async function windowManagerPresent(env) {
    try {
      const { stdout } = await runTool('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], {
        timeoutMs: 4_000,
        env,
        allowFailure: true,
      })
      return /window id/i.test(String(stdout))
    } catch (error) {
      log('window-manager probe failed:', errorText(error))
      return false
    }
  }

  async function screenStart({ width, height }) {
    const w = requireInteger(width, 'width', MIN_SCREEN_PX, MAX_SCREEN_PX)
    const h = requireInteger(height, 'height', MIN_SCREEN_PX, MAX_SCREEN_PX)
    // Chain onto whatever lifecycle call is in flight — including a failed one
    // — and await OUR link, not the field, which a concurrent call may replace.
    const pending = lifecycle.then(
      () => startScreen(w, h),
      () => startScreen(w, h),
    )
    lifecycle = pending
    await pending
  }

  async function startScreen(width, height) {
    // Idempotent: a second screen-start while a screen is up is a no-op. The
    // host's own record of the size wins; resizing means stop then start.
    if (screen) {
      if (screen.width !== width || screen.height !== height) {
        log(
          `screen-start ignored: a ${screen.width}x${screen.height} screen is already running`,
          `(asked for ${width}x${height}; stop it first to resize)`,
        )
      }
      return
    }

    // A previous Xvfb that died hard leaves its lock behind and the next one
    // refuses to start. We only get here with no screen of our own running, so
    // clearing them is safe and saves an unexplainable failure.
    for (const stale of [X_LOCK, X_SOCKET]) {
      if (!existsSync(stale)) continue
      try {
        unlinkSync(stale)
        log(`removed stale ${stale}`)
      } catch (error) {
        log(`could not remove stale ${stale}:`, errorText(error))
      }
    }
    try {
      mkdirSync(process.env.XDG_RUNTIME_DIR ?? '/run/desk-agent', { recursive: true, mode: 0o700 })
    } catch (error) {
      log('could not ensure XDG_RUNTIME_DIR:', errorText(error))
    }

    const children = []
    try {
      // RANDR so toolkits can ask about the screen; DAMAGE so a future capture
      // path can be driven by damage regions rather than polling (§3.13).
      const xvfb = spawnTracked('Xvfb', 'Xvfb', [
        DISPLAY,
        '-screen',
        '0',
        `${width}x${height}x24`,
        '-nolisten',
        'tcp',
        '+extension',
        'RANDR',
        '+extension',
        'DAMAGE',
      ], { ...process.env, DISPLAY })
      children.push(xvfb)
      await waitForDisplay(xvfb)

      const bus = await startSessionBus()
      const sessionEnv = { DBUS_SESSION_BUS_ADDRESS: bus.address }
      // Publish the session up-front so baseEnv() picks it up for the children
      // we are about to start; a failure below tears all of this back down.
      screen = { width, height, children, sessionEnv, dbusPid: bus.pid }

      // AT-SPI is opportunistic: if the bus launcher is missing or dies, the
      // desk still works and observe() simply returns a11y: null (§3.10).
      const launcher = findAtSpiLauncher()
      if (launcher) {
        children.push(spawnTracked('at-spi-bus-launcher', launcher, ['--launch-immediately'], baseEnv()))
      } else {
        log('at-spi-bus-launcher not found; accessibility trees will be unavailable')
      }

      children.push(spawnTracked('xfce4-session', 'xfce4-session', [], baseEnv()))

      // xfce4-session normally starts xfwm4 and xfsettingsd itself. If it did
      // not manage to (a stripped image, a session-manager failure), start them
      // directly rather than leaving the desk without a window manager — with
      // no WM there are no titlebars, no focus, and no window list.
      const deadline = Date.now() + WM_READY_TIMEOUT_MS
      let managed = false
      while (Date.now() < deadline) {
        if (await windowManagerPresent(baseEnv())) {
          managed = true
          break
        }
        await sleep(250)
      }
      if (!managed) {
        log('no window manager after xfce4-session; starting xfwm4 and xfsettingsd directly')
        children.push(spawnTracked('xfwm4', 'xfwm4', [], baseEnv()))
        children.push(spawnTracked('xfsettingsd', 'xfsettingsd', [], baseEnv()))
      }

      log(`screen up: ${width}x${height} on ${DISPLAY}${managed ? '' : ' (fallback window manager)'}`)
    } catch (error) {
      // Never leave half a session behind: unwind everything we started.
      const started = screen
      screen = null
      for (const tracked of children.reverse()) await terminate(tracked, 1_000)
      if (started && started.dbusPid) killPid(started.dbusPid)
      throw new Error(`could not start the screen: ${errorText(error)}`)
    }
  }

  function killPid(pid) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch (error) {
      // ESRCH just means it is already gone, which is the state we wanted.
      if (!error || error.code !== 'ESRCH') log(`could not signal pid ${pid}:`, errorText(error))
    }
  }

  async function screenStop() {
    const pending = lifecycle.then(stopScreen, stopScreen)
    lifecycle = pending
    await pending
  }

  async function stopScreen() {
    // Stopping the screen stops everything that depends on it, whether or not
    // the host remembered to.
    stopFrames()
    await stopHandover()
    if (!screen) return
    const { children, dbusPid } = screen
    screen = null
    // Reverse order: the session and its helpers first, the X server last, so
    // clients are not killed by their display vanishing under them.
    for (const tracked of [...children].reverse()) await terminate(tracked)
    if (dbusPid) killPid(dbusPid)
    for (const stale of [X_LOCK, X_SOCKET]) {
      if (!existsSync(stale)) continue
      try {
        unlinkSync(stale)
      } catch (error) {
        log(`could not remove ${stale} after stop:`, errorText(error))
      }
    }
    log('screen stopped')
  }

  // --- perception -----------------------------------------------------------

  /** A full-screen, UNSCALED PNG of :99. */
  async function capture() {
    const { stdout } = await runTool('import', ['-display', DISPLAY, '-window', 'root', 'png:-'], {
      timeoutMs: SCREENSHOT_TIMEOUT_MS,
      env: baseEnv(),
      binary: true,
      maxBuffer: SCREENSHOT_CAP_BYTES,
    })
    const png = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout), 'binary')
    // Read the size out of the image itself rather than trusting our own record
    // of it. The coordinate contract is only true if the numbers we report are
    // the numbers the pixels actually have.
    const { width, height } = pngDimensions(png)
    if (screen && (width !== screen.width || height !== screen.height)) {
      log(`captured ${width}x${height} but the screen is ${screen.width}x${screen.height}`)
    }
    return { png, width, height }
  }

  /**
   * Window list via wmctrl, which reads the EWMH client list — so it needs a
   * window manager. Failure here is NOT fatal to observe(): perception is
   * pixels-primary, and a screenshot with no window list is still a usable
   * observation. It is logged, never swallowed.
   */
  async function listWindows() {
    const { stdout, failed, stderr } = await runTool('wmctrl', ['-lp'], {
      timeoutMs: 5_000,
      env: baseEnv(),
      allowFailure: true,
    })
    if (failed) {
      log('wmctrl could not list windows:', stderr.trim().slice(0, 256) || 'non-zero exit')
      return { windows: [], pids: new Map() }
    }
    const windows = []
    // WindowInfo carries no pid (see events.d.ts), but the pid is how the
    // accessibility side finds the same application, so keep it beside the
    // list rather than inventing a field the host would reject.
    const pids = new Map()
    for (const line of String(stdout).split('\n')) {
      const match = /^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(\d+)\s+(\S+)\s?(.*)$/.exec(line)
      if (!match) continue
      const [, id, , pid, , rawTitle] = match
      windows.push({
        id,
        // The host's parser requires a non-empty title, and plenty of real
        // windows have none, so name the nameless.
        title: rawTitle.trim() === '' ? '(untitled)' : rawTitle.trim().slice(0, 512),
        appId: appIdForPid(pid),
      })
      pids.set(id, Number(pid))
      if (windows.length >= 256) break // the protocol caps the list here too
    }
    return { windows, pids }
  }

  /** The executable name behind a window, read from /proc — no extra process. */
  function appIdForPid(pid) {
    if (!/^\d+$/.test(pid) || pid === '0') return null
    try {
      const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
      return comm === '' ? null : comm
    } catch (error) {
      log(`could not read /proc/${pid}/comm:`, errorText(error))
      return null
    }
  }

  /**
   * The focused window.
   *
   * `getactivewindow` reads _NET_ACTIVE_WINDOW and therefore returns the same
   * client window id wmctrl lists. `getwindowfocus` asks X directly and can
   * return an inner child window that matches nothing in the list, so it is
   * only the fallback — used when there is no EWMH-compliant WM to ask.
   */
  async function focusedWindow(windows, pids) {
    const id = await focusedWindowId()
    if (id === null) return { window: null, pid: null }
    const hex = `0x${id.toString(16).padStart(8, '0')}`
    const match = windows.find((window) => Number(window.id) === id)
    if (match) return { window: match, pid: pids.get(match.id) ?? null }
    // Focus on something the window list does not know about: report it anyway
    // with whatever name we can get, rather than claiming nothing is focused.
    const named = await runTool('xdotool', ['getwindowname', String(id)], {
      timeoutMs: XDOTOOL_TIMEOUT_MS,
      env: baseEnv(),
      allowFailure: true,
    })
    const title = named.failed ? '' : String(named.stdout).trim()
    const owned = await runTool('xdotool', ['getwindowpid', String(id)], {
      timeoutMs: XDOTOOL_TIMEOUT_MS,
      env: baseEnv(),
      allowFailure: true,
    })
    const pid = owned.failed ? null : Number.parseInt(String(owned.stdout).trim(), 10)
    return {
      window: {
        id: hex,
        title: title === '' ? '(untitled)' : title.slice(0, 512),
        appId: Number.isInteger(pid) ? appIdForPid(String(pid)) : null,
      },
      pid: Number.isInteger(pid) ? pid : null,
    }
  }

  async function focusedWindowId() {
    for (const command of ['getactivewindow', 'getwindowfocus']) {
      const { stdout, failed } = await runTool('xdotool', [command], {
        timeoutMs: XDOTOOL_TIMEOUT_MS,
        env: baseEnv(),
        allowFailure: true,
      })
      if (failed) continue
      const id = Number.parseInt(String(stdout).trim(), 10)
      if (Number.isInteger(id) && id > 0) return id
    }
    return null
  }

  /**
   * OPPORTUNISTIC AT-SPI (§3.10). Everything about this call is best-effort:
   * a missing python3, a missing pyatspi, an application that exposes no tree,
   * a tree that takes too long — every one of them returns null and lets the
   * caller ship the pixels. The rule is that accessibility never gates
   * perception, because a stale tree that silently disagrees with the screen is
   * worse than no tree at all.
   *
   * The pid of the focused window is passed through so the helper reads the
   * tree of the SAME application the screenshot shows. Without it, "the active
   * window" on an XFCE desktop can resolve to the window manager's own hidden
   * 5x5 proxy window — a tree that is technically correct and completely
   * useless.
   */
  async function readA11yTree(focusedPid) {
    if (!existsSync(ATSPI_DUMP)) {
      log('atspi-dump.py is not installed beside the agent; a11y unavailable')
      return null
    }
    try {
      const { stdout } = await runTool(
        'python3',
        [
          ATSPI_DUMP,
          'dump',
          '--max-depth',
          String(ATSPI_MAX_DEPTH),
          '--max-nodes',
          String(ATSPI_MAX_NODES),
          ...(Number.isInteger(focusedPid) && focusedPid > 0 ? ['--pid', String(focusedPid)] : []),
        ],
        { timeoutMs: ATSPI_TIMEOUT_MS, env: baseEnv(), maxBuffer: ATSPI_CAP_BYTES },
      )
      const text = String(stdout).trim()
      if (text === '' || text === 'null') return null
      const parsed = JSON.parse(text)
      return parsed === null ? null : parsed
    } catch (error) {
      log('a11y tree unavailable (pixels are unaffected):', errorText(error))
      return null
    }
  }

  async function observe() {
    requireScreen()
    const { png, width, height } = await capture()
    const { windows, pids } = await listWindows()
    const { window: focused, pid } = await focusedWindow(windows, pids)
    lastFocusedPid = pid
    const a11y = await readA11yTree(pid)
    // GuestObservation.png is a BASE64 STRING, not a Buffer: the wire is JSON.
    return { png: png.toString('base64'), width, height, a11y, windows, focused }
  }

  // --- input ----------------------------------------------------------------

  /**
   * THE COORDINATE CONTRACT (spec §5.1) — read this before touching anything
   * in here.
   *
   * Input coordinates are in the pixel space of the most recent observe(),
   * ONE TO ONE. That holds because the chain is identity end to end:
   *
   *   Xvfb runs at exactly the width/height screen-start asked for;
   *   `import -window root` captures that framebuffer unscaled;
   *   observe() reports the dimensions read out of the captured PNG itself;
   *   xdotool addresses the same root window in the same pixel space.
   *
   * There is NO scaling step anywhere in this file, and none may be added. If
   * a future capture path ever rescales on the way out, it MUST undo that
   * scaling on the way in, here. Getting this wrong makes every click land
   * slightly off — which looks exactly like the model being bad at its job and
   * is miserable to diagnose. The bounds check below exists to make a breach
   * loud instead of subtle.
   */
  function assertOnScreen(x, y) {
    const { width, height } = requireScreen()
    requireInteger(x, 'x', 0, MAX_SCREEN_PX)
    requireInteger(y, 'y', 0, MAX_SCREEN_PX)
    if (x >= width || y >= height) {
      throw new Error(
        `(${x}, ${y}) is outside the ${width}x${height} screen; `
        + 'input coordinates are in the pixel space of the most recent observe()',
      )
    }
  }

  const BUTTON_NUMBERS = { left: '1', middle: '2', right: '3' }

  /**
   * NEVER pass `--sync` to `mousemove`.
   *
   * xdotool implements it as "wait until the pointer has moved AWAY from where
   * it was", so a move to the coordinates the pointer is ALREADY at never
   * returns — and moving twice to the same place is completely ordinary for an
   * agent (observe, move, look, click). Measured in a real XFCE session: with
   * `--sync` that call hangs until this file's timeout kills it, which looks
   * exactly like a dead desk.
   *
   * Ordering is safe without it: a pointer motion and the button press that
   * follows it are requests on ONE X connection — a single chained `xdotool
   * mousemove X Y click N` — and the server processes a connection's requests
   * in order, so the press always lands after the move.
   */
  function xdotool(args, timeoutMs = XDOTOOL_TIMEOUT_MS) {
    return runTool('xdotool', args, { timeoutMs, env: baseEnv() })
  }

  async function input(action) {
    requireScreen()
    if (!action || typeof action !== 'object') throw new Error('input must be an object')
    switch (action.type) {
      case 'move': {
        assertOnScreen(action.x, action.y)
        await xdotool(['mousemove', String(action.x), String(action.y)])
        return
      }
      case 'click': {
        assertOnScreen(action.x, action.y)
        const button = BUTTON_NUMBERS[action.button ?? 'left']
        if (!button) throw new Error(`button must be left, middle, or right (got ${String(action.button)})`)
        await xdotool([
          'mousemove', String(action.x), String(action.y),
          'click', '--clearmodifiers', button,
        ])
        return
      }
      case 'type': {
        const text = requireText(action.text, 'text', TYPE_MAX_CHARS)
        if (text === '') return
        // `--` stops xdotool reading the text as options; the text itself is a
        // single argv entry and never touches a shell.
        await xdotool(
          ['type', '--clearmodifiers', '--delay', String(TYPE_DELAY_MS), '--', text],
          XDOTOOL_TIMEOUT_MS + text.length * TYPE_DELAY_MS * 3,
        )
        return
      }
      case 'key': {
        const combo = requireText(action.combo, 'combo', 128)
        if (!KEY_COMBO_PATTERN.test(combo)) {
          throw new Error(`combo must look like "ctrl+shift+t" or "Return" (got ${combo})`)
        }
        // No `--` here: the pattern above already guarantees the combo cannot
        // start with a dash, and xdotool's key parser would take a literal
        // `--` as a keystroke.
        await xdotool(['key', '--clearmodifiers', combo])
        return
      }
      case 'scroll': {
        assertOnScreen(action.x, action.y)
        const dx = requireInteger(action.dx ?? 0, 'dx', -1_000_000, 1_000_000)
        const dy = requireInteger(action.dy ?? 0, 'dy', -1_000_000, 1_000_000)
        await xdotool(['mousemove', String(action.x), String(action.y)])
        // X11 wheels are buttons: 4 up, 5 down, 6 left, 7 right. dx/dy arrive
        // as PIXEL deltas in observe() space, so they are converted to wheel
        // clicks at SCROLL_PIXELS_PER_CLICK per click (at least one, so a small
        // nudge is never silently dropped).
        if (dy !== 0) await wheel(dy > 0 ? '5' : '4', Math.abs(dy))
        if (dx !== 0) await wheel(dx > 0 ? '7' : '6', Math.abs(dx))
        return
      }
      case 'drag': {
        const from = action.from ?? {}
        const to = action.to ?? {}
        assertOnScreen(from.x, from.y)
        assertOnScreen(to.x, to.y)
        await xdotool(['mousemove', String(from.x), String(from.y)])
        await xdotool(['mousedown', '1'])
        try {
          // Intermediate motion: a single jump from press to release is
          // ignored by plenty of drag implementations.
          for (let step = 1; step <= DRAG_STEPS; step += 1) {
            const x = Math.round(from.x + ((to.x - from.x) * step) / DRAG_STEPS)
            const y = Math.round(from.y + ((to.y - from.y) * step) / DRAG_STEPS)
            await xdotool(['mousemove', String(x), String(y)])
          }
        } finally {
          // The button must come back up even if a move failed, or the desk is
          // left with a stuck mouse button and every later click is a drag.
          await xdotool(['mouseup', '1'])
        }
        return
      }
      default:
        throw new Error(`unsupported input type: ${String(action && action.type)}`)
    }
  }

  async function wheel(button, pixels) {
    const clicks = Math.min(
      SCROLL_MAX_CLICKS,
      Math.max(1, Math.round(pixels / SCROLL_PIXELS_PER_CLICK)),
    )
    await xdotool(['click', '--clearmodifiers', '--repeat', String(clicks), button])
  }

  /**
   * Invoke a named AT-SPI action on a node from the LAST observation.
   *
   * Node ids are structural paths ("0/3/1" = root, fourth child, second child)
   * produced by atspi-dump.py. They are stable WITHIN one observation and
   * meaningless outside it: the tree is re-walked from the currently focused
   * application, so a path from an older observation may now address a
   * different node, or nothing. Always observe(), then invoke.
   */
  async function a11yInvoke({ nodeId, action }) {
    requireScreen()
    const id = requireText(nodeId, 'nodeId', 512)
    if (!/^\d+(\/\d+)*$/.test(id)) throw new Error(`nodeId must be a path like "0/3/1" (got ${id})`)
    const name = requireText(action, 'action', 128)
    if (!/^[A-Za-z0-9 _.:-]+$/.test(name)) throw new Error(`action name is not usable: ${name}`)
    if (!existsSync(ATSPI_DUMP)) {
      throw new Error('atspi-dump.py is not installed beside the agent; a11y actions are unavailable')
    }
    await runTool(
      'python3',
      [
        ATSPI_DUMP,
        'invoke',
        '--node-id',
        id,
        '--action',
        name,
        // Resolve against the application the last observation described.
        ...(Number.isInteger(lastFocusedPid) && lastFocusedPid > 0
          ? ['--pid', String(lastFocusedPid)]
          : []),
      ],
      { timeoutMs: ATSPI_TIMEOUT_MS, env: baseEnv() },
    )
  }

  // --- apps and clipboard ---------------------------------------------------

  async function launch({ appId, args }) {
    requireScreen()
    const program = requireLaunchable(appId)
    const argv = Array.isArray(args) ? args : []
    if (argv.length > 64) throw new Error('launch accepts at most 64 arguments')
    const cleanArgv = argv.map((value, index) => requireText(value, `args[${index}]`, 4096))
    // Detached and unref'd: the app outlives this call and this connection, and
    // we deliberately do not wait for a window to appear — the caller observes.
    const child = spawn(program, cleanArgv, {
      env: baseEnv(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    // spawn() reports ENOENT asynchronously; surface it in the log rather than
    // letting an unhandled 'error' event take down the agent.
    child.on('error', (error) => log(`launch of ${program} failed:`, errorText(error)))
    child.unref()
    log(`launched ${program}`)
  }

  async function clipboardRead() {
    requireScreen()
    const { stdout, failed, stderr } = await runTool(
      'xclip',
      ['-selection', 'clipboard', '-o'],
      {
        timeoutMs: CLIPBOARD_TIMEOUT_MS,
        env: baseEnv(),
        maxBuffer: CLIPBOARD_CAP_BYTES,
        allowFailure: true,
      },
    )
    if (failed) {
      // An empty clipboard is an error to xclip ("target STRING not available")
      // but an ordinary answer to us. Anything else is reported.
      const detail = stderr.trim()
      if (/not available|no selection|Error: target/i.test(detail) || detail === '') {
        return { text: '' }
      }
      throw new Error(`xclip could not read the clipboard: ${detail.slice(0, 256)}`)
    }
    return { text: String(stdout) }
  }

  function clipboardWrite({ text }) {
    requireScreen()
    const value = requireText(text, 'text', CLIPBOARD_CAP_BYTES)
    return new Promise((resolve, reject) => {
      const child = spawn('xclip', ['-selection', 'clipboard', '-i'], {
        env: baseEnv(),
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true,
      })
      let stderrText = ''
      let settled = false
      child.stderr.on('data', (chunk) => {
        stderrText = (stderrText + chunk.toString('utf8')).slice(-512)
      })
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(new Error(`xclip did not finish writing the clipboard within ${CLIPBOARD_TIMEOUT_MS}ms`))
      }, CLIPBOARD_TIMEOUT_MS)
      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(`xclip could not be started: ${errorText(error)}`))
      })
      // xclip forks into the background to own the selection, so the process we
      // spawned exits as soon as it has read stdin. That exit is the success
      // signal; the daemonized child keeps the clipboard alive.
      child.on('exit', (code, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code === 0) resolve()
        else {
          reject(new Error(
            `xclip exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`
            + `${stderrText.trim() ? `: ${stderrText.trim()}` : ''}`,
          ))
        }
      })
      child.stdin.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(`could not write to xclip: ${errorText(error)}`))
      })
      child.stdin.end(Buffer.from(value, 'utf8'))
    })
  }

  // --- capture --------------------------------------------------------------

  /**
   * DAMAGE-AWARE EMISSION (§3.13): a still screen must cost almost nothing.
   *
   * The loop captures at the requested fps and hashes each PNG; an identical
   * consecutive frame is NOT emitted, so a desk that nobody is touching sends
   * one keepalive every FRAMES_KEEPALIVE_MS and nothing else. The keepalive is
   * what stops a subscriber who joined during a still period from staring at
   * a blank stage.
   *
   * The loop is single-flight — the next tick is scheduled only after the
   * current capture has finished — so a slow capture or a slow consumer can
   * never pile up work.
   */
  async function framesStart({ fps, width, height }) {
    const screenNow = requireScreen()
    const rate = requireInteger(fps, 'fps', FRAMES_MIN_FPS, FRAMES_MAX_FPS)
    const w = requireInteger(width, 'width', MIN_SCREEN_PX, MAX_SCREEN_PX)
    const h = requireInteger(height, 'height', MIN_SCREEN_PX, MAX_SCREEN_PX)
    if (w !== screenNow.width || h !== screenNow.height) {
      // We never rescale (see the coordinate contract): frames go out at the
      // screen's real size and the event carries the real dimensions.
      log(`frames requested at ${w}x${h}; emitting at the screen's ${screenNow.width}x${screenNow.height}`)
    }
    const sendEvent = currentSendEvent()
    if (!sendEvent) throw new Error('no host connection is available to receive frames')

    stopFrames()
    const session = {
      seq: 0,
      lastHash: null,
      lastEmitAt: 0,
      stopped: false,
      timer: null,
      intervalMs: Math.max(1, Math.round(1000 / rate)),
      sendEvent,
    }
    frames = session

    const tick = async () => {
      if (session.stopped) return
      try {
        const shot = await capture()
        if (session.stopped) return
        const hash = createHash('sha256').update(shot.png).digest('hex')
        const now = Date.now()
        const changed = hash !== session.lastHash
        const keepalive = now - session.lastEmitAt >= FRAMES_KEEPALIVE_MS
        if (changed || keepalive) {
          const data = shot.png.toString('base64')
          if (data.length > FRAME_PAYLOAD_CAP_BYTES) {
            log(`skipping a ${data.length}-byte frame; the payload cap is ${FRAME_PAYLOAD_CAP_BYTES}`)
          } else {
            session.seq += 1
            session.lastHash = hash
            session.lastEmitAt = now
            session.sendEvent({
              event: 'frame',
              seq: session.seq,
              width: shot.width,
              height: shot.height,
              data,
            })
          }
        }
      } catch (error) {
        // A capture failure must not kill the loop silently, and must not spin:
        // log it and let the normal interval apply.
        log('frame capture failed:', errorText(error))
        if (!screen) {
          log('stopping the frame loop: the screen is gone')
          stopFrames()
          return
        }
      }
      if (session.stopped) return
      session.timer = setTimeout(tick, session.intervalMs)
    }

    session.timer = setTimeout(tick, 0)
    log(`frames started at ${rate}fps`)
  }

  function stopFrames() {
    if (!frames) return
    frames.stopped = true
    if (frames.timer) clearTimeout(frames.timer)
    frames = null
    log('frames stopped')
  }

  async function framesStop() {
    stopFrames()
  }

  // --- handover -------------------------------------------------------------

  /**
   * Hand the screen to a person, over VNC bound to LOCALHOST INSIDE THE GUEST.
   * The runner owns exposing it outward (it already relays the vsock/websocket
   * path), so nothing here ever listens on a routable address.
   *
   * MASKING (§3.14) is enforced HOST-side by @appkit/desk: while a handover is
   * active it drops input events, frames, window focus and the clipboard before
   * they reach the recording port. This file deliberately does NOT re-implement
   * that — and deliberately keeps NO record of handover input either. x11vnc
   * injects events through XTEST without ever passing through this agent, so
   * there is no path by which a person's keystrokes could reach the ledger from
   * the guest side. That is the property the whole design turns on: the ledger
   * records that a handover happened, who drove and for how long, never what
   * they typed.
   *
   * AUTO-REVOKE is defence in depth: the host tracks the TTL and so do we. If
   * handoverEnd never arrives — a crashed runner, a dropped connection — the
   * guest-side timer kills x11vnc anyway.
   */
  async function handoverBegin({ ttlMs, scope }) {
    requireScreen()
    const ttl = requireInteger(ttlMs, 'ttlMs', HANDOVER_MIN_TTL_MS, HANDOVER_MAX_TTL_MS)
    if (scope !== 'view' && scope !== 'control') throw new Error('scope must be view or control')
    if (handover) throw new Error('a handover is already active in this guest')

    const seconds = Math.max(1, Math.round(ttl / 1000))
    const args = [
      '-display', DISPLAY,
      '-rfbport', String(HANDOVER_PORT),
      '-localhost', // bind 127.0.0.1 only — the runner does the exposing
      '-nopw',
      '-forever', // survive a viewer reconnect; our own timer bounds the life
      '-shared',
      '-timeout', String(seconds), // give up if nobody ever connects
      '-noxrecord',
      '-quiet',
    ]
    // scope 'view' is enforced in the guest as well as in the UI: x11vnc simply
    // refuses to inject input at all.
    if (scope === 'view') args.push('-viewonly')

    const tracked = spawnTracked('x11vnc', 'x11vnc', args, baseEnv())
    const session = { tracked, timer: null, url: `vnc://127.0.0.1:${HANDOVER_PORT}`, scope }
    handover = session
    try {
      await waitForPort(HANDOVER_PORT, HANDOVER_READY_TIMEOUT_MS, tracked)
    } catch (error) {
      handover = null
      await terminate(tracked, 1_000)
      throw new Error(`could not start the handover: ${errorText(error)}`)
    }
    session.timer = setTimeout(() => {
      log(`handover TTL of ${ttl}ms elapsed; revoking`)
      stopHandover().catch((error) => log('handover auto-revoke failed:', errorText(error)))
    }, ttl)
    tracked.child.once('exit', () => {
      // x11vnc gave up on its own (nobody connected, or the viewer left after
      // -once semantics); drop our record so a later begin can start cleanly.
      if (handover === session) {
        if (session.timer) clearTimeout(session.timer)
        handover = null
      }
    })
    log(`handover open on ${session.url} (scope=${scope}, ttl=${ttl}ms)`)
    return { url: session.url }
  }

  /** Idempotent: ending a handover that is not running is a success. */
  async function handoverEnd() {
    await stopHandover()
  }

  async function stopHandover() {
    if (!handover) return
    const session = handover
    handover = null
    if (session.timer) clearTimeout(session.timer)
    await terminate(session.tracked)
    log('handover closed')
  }

  /** Wait until something is accepting on 127.0.0.1:port, or say why not. */
  function waitForPort(port, timeoutMs, tracked) {
    const deadline = Date.now() + timeoutMs
    const attempt = () =>
      new Promise((resolve, reject) => {
        const socket = netConnect({ host: '127.0.0.1', port })
        const done = (error) => {
          socket.removeAllListeners()
          socket.destroy()
          if (error) reject(error)
          else resolve()
        }
        socket.setTimeout(1_000, () => done(new Error('connect timed out')))
        socket.once('connect', () => done(null))
        socket.once('error', (error) => done(error))
      })
    const poll = async () => {
      let lastReason = 'no attempt was made'
      while (Date.now() < deadline) {
        if (tracked && tracked.exited) {
          throw new Error(
            `x11vnc exited before it listened: ${tracked.stderrTail.trim().slice(0, 512) || 'no output'}`,
          )
        }
        try {
          await attempt()
          return
        } catch (error) {
          lastReason = errorText(error)
        }
        await sleep(150)
      }
      throw new Error(`nothing was listening on 127.0.0.1:${port} after ${timeoutMs}ms: ${lastReason}`)
    }
    return poll()
  }

  // --- wiring ---------------------------------------------------------------

  /**
   * The frame loop needs a push channel. Connections come and go, so the
   * desktop tier holds the most recent one and drops the loop when writing to
   * it fails.
   */
  let sendEventProvider = () => null
  function currentSendEvent() {
    const sendEvent = sendEventProvider()
    if (!sendEvent) return null
    return (event) => {
      try {
        sendEvent(event)
      } catch (error) {
        log('could not push an event to the host; stopping frames:', errorText(error))
        stopFrames()
      }
    }
  }
  function useSendEvent(provider) {
    sendEventProvider = provider
  }

  /**
   * The connection that owned the push channel has gone. Stop capturing rather
   * than shouting frames at a destroyed socket forever — the host restarts the
   * stream when it reconnects.
   */
  function dropSendEvent(provider) {
    if (sendEventProvider !== provider) return
    sendEventProvider = () => null
    if (frames) log('the host connection closed; stopping frames')
    stopFrames()
  }

  async function shutdown() {
    stopFrames()
    await stopHandover()
    await screenStop()
  }

  return {
    screenStart,
    screenStop,
    observe,
    input,
    a11yInvoke,
    launch,
    clipboardRead,
    clipboardWrite,
    framesStart,
    framesStop,
    handoverBegin,
    handoverEnd,
    useSendEvent,
    dropSendEvent,
    shutdown,
  }
}

/** One desk, one desktop. */
const desktop = createDesktopTier()

/**
 * Whether the guest has a virtio-gpu DRM node. Cheap and honest: look for a
 * card in /dev/dri and check the driver behind it in sysfs. Anything we cannot
 * confirm reports false — a wrong `true` here would have the host expect
 * hardware acceleration that is not there.
 */
function detectVirtioGpu() {
  try {
    if (!existsSync('/dev/dri')) return false
    const cards = readdirSync('/dev/dri').filter((entry) => entry.startsWith('card'))
    for (const card of cards) {
      const driverLink = `/sys/class/drm/${card}/device/driver`
      if (!existsSync(driverLink)) continue
      if (basename(readlinkSync(driverLink)).includes('virtio')) return true
    }
    return false
  } catch (error) {
    log('virtio-gpu detection failed; reporting false:', errorText(error))
    return false
  }
}

/**
 * Build the handler set for one connection. `sendEvent` is the RunningGuestAgent
 * push channel, wired here so a detached job can emit its `job-exit` event to the
 * host when the child finally exits.
 */
function createHandlers(getSendEvent) {
  /** jobId -> ChildProcess, for jobSignal and exit reporting. */
  const jobs = new Map()

  // The desktop tier outlives any single connection, but its frame loop pushes
  // over whichever connection is current.
  desktop.useSendEvent(getSendEvent)

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
      return { virtioGpu: detectVirtioGpu() }
    },

    // --- desktop tier: X11 (Xvfb :99 + XFCE), pixels-primary perception -----
    screenStart: (call) => desktop.screenStart(call),
    screenStop: () => desktop.screenStop(),
    observe: () => desktop.observe(),
    input: (action) => desktop.input(action),
    a11yInvoke: (call) => desktop.a11yInvoke(call),
    launch: (call) => desktop.launch(call),
    clipboardRead: () => desktop.clipboardRead(),
    clipboardWrite: (call) => desktop.clipboardWrite(call),
    framesStart: (call) => desktop.framesStart(call),
    framesStop: () => desktop.framesStop(),
    handoverBegin: (call) => desktop.handoverBegin(call),
    handoverEnd: () => desktop.handoverEnd(),
  }
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
    const getSendEvent = () => (running ? running.sendEvent : null)
    const handlers = createHandlers(getSendEvent)
    running = runGuestAgent({ stream: connection, handlers })
    // The desktop tier's frame loop pushes over this connection; when it goes,
    // so does the loop.
    running.closed.then(
      () => desktop.dropSendEvent(getSendEvent),
      (error) => {
        log('connection closed with an error:', errorText(error))
        desktop.dropSendEvent(getSendEvent)
      },
    )
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
    // Take the desktop down with us: an orphaned Xvfb or x11vnc would keep the
    // display busy and a later screen-start would fail for no visible reason.
    desktop.shutdown().catch((error) => log('desktop shutdown failed:', errorText(error)))
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
