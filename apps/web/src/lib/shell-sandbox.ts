import 'server-only'
import { mkdir } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { DEFAULT_PROCESS_PATH, spawnBubblewrappedProcess } from '@appkit/process-sandbox'

/**
 * Running a shell command in an agent's workspace — and where that happens.
 *
 * Bubblewrap has to build a sandbox before anything can run in it, and building
 * one needs a user namespace and the mount that follows. Measured on the
 * deployment host, one combination at a time, that needs all three of
 * CAP_SYS_ADMIN, `seccomp=unconfined` and `apparmor=unconfined` — and Docker
 * Swarm has never supported `security_opt` on a service (moby#47545, open since
 * 2017), so a stack-deployed container cannot have them. Every `run_shell` an
 * agent tried failed at that first step, and the agents worked around it by
 * leaving each other notes.
 *
 * Granting all three to `web`, `worker` and `voice-agent` would have fixed it
 * and was the wrong trade: those are the containers that execute
 * model-directed code and drive a browser across the open web, on a host that
 * runs other applications too. Removing the outer confinement from the most
 * exposed containers in order to enable an inner sandbox is backwards.
 *
 * So the shell gets its own container instead — one small service that does
 * nothing but this, deployed outside the swarm stack where the security options
 * actually apply, reachable only on the internal network. The blast radius of
 * those privileges is a process whose entire job is to run one sandboxed
 * command and hand back what it printed.
 *
 * This module is the one implementation both ends share: the runner executes
 * it, and a deployment with no runner configured executes the same thing
 * locally (a developer machine, where bubblewrap works unaided). The behaviour
 * an agent sees is identical either way.
 */

/** How long one command may run before it is killed. */
export const SHELL_TIMEOUT_MS = 120_000

/** How much of what it printed is kept. */
export const OUTPUT_CAP_BYTES = 64 * 1024

export type ShellOutcome = {
  status: 'completed' | 'failed' | 'timeout'
  exitCode: number | null
  output: string
}

/**
 * Is this path inside that root? Used by the runner to refuse a request to
 * make something else writable.
 *
 * Both sides are resolved first, and the comparison is on a separator boundary
 * so `/data/homes-evil` is not treated as living inside `/data/homes`.
 */
export function insideRoot(root: string, candidate: string): boolean {
  const base = resolve(root)
  const target = resolve(candidate)
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)
}

/**
 * Run one command with the agent's home as the only writable place.
 *
 * Pure execution: no database, no tenant scope, nothing that would stop it
 * running in a container that holds neither.
 */
export async function runSandboxedShell(args: {
  /** The agent's home — the one writable path, and the value of $HOME. */
  home: string
  /** Where to run, already resolved to somewhere inside the home. */
  cwd: string
  /** The command line, run with `/bin/sh -lc`. */
  command: string
  timeoutMs?: number
}): Promise<ShellOutcome> {
  await mkdir(args.cwd, { recursive: true })
  const limit = args.timeoutMs ?? SHELL_TIMEOUT_MS

  const child = spawnBubblewrappedProcess({
    // /usr/bin/sh, not /bin/sh, and it matters. The sandbox read-only-binds
    // the command's own directory when that directory is not already covered,
    // and then symlinks /bin -> usr/bin. Ask for /bin/sh and it binds /bin
    // first, so the symlink collides: "Can't make symlink at /bin: File
    // exists", every time, on a correctly privileged host. /usr/bin is already
    // inside the default read-only set, so nothing extra is bound and the
    // layout it expects is the layout it gets. Same shell either way — on a
    // merged-/usr image /bin IS usr/bin.
    command: '/usr/bin/sh',
    args: ['-lc', args.command],
    cwd: args.cwd,
    writablePaths: [args.home],
    environment: {
      HOME: args.home,
      PATH: DEFAULT_PROCESS_PATH,
      LANG: 'C.UTF-8',
      TMPDIR: '/tmp',
    },
  })

  let output = ''
  let truncated = false
  const append = (chunk: Buffer) => {
    if (output.length >= OUTPUT_CAP_BYTES) {
      truncated = true
      return
    }
    output += chunk.toString('utf8').slice(0, OUTPUT_CAP_BYTES - output.length)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)

  const result = await new Promise<{ status: ShellOutcome['status']; exitCode: number | null }>((settle) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ status: 'timeout', exitCode: null })
    }, limit)
    child.on('error', () => {
      clearTimeout(timer)
      settle({ status: 'failed', exitCode: null })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      settle({ status: code === 0 ? 'completed' : 'failed', exitCode: code })
    })
  })

  if (truncated) output += '\n[output truncated]'
  if (result.status === 'timeout') output += `\n[killed after ${Math.round(limit / 1000)}s]`
  return { ...result, output }
}

/** Where the shell runs, when it does not run here. */
export type ShellRunner = { url: string; token: string } | null

export function configuredRunner(): ShellRunner {
  const url = process.env.BUNKHOUSE_SHELL_URL
  const token = process.env.BUNKHOUSE_SHELL_TOKEN
  if (!url || !token) return null
  return { url: url.replace(/\/$/, ''), token }
}

/**
 * Ask the runner to do it. Any failure to reach it is reported as the command
 * failing, in words an agent can act on — never as a silent empty result,
 * which is how an agent concludes its workspace is broken and stops trying.
 */
export async function runShellRemotely(
  runner: { url: string; token: string },
  body: { home: string; cwd: string; command: string },
): Promise<ShellOutcome> {
  try {
    const response = await fetch(`${runner.url}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${runner.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SHELL_TIMEOUT_MS + 15_000),
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300)
      return {
        status: 'failed',
        exitCode: null,
        output: `The workspace shell refused this: ${response.status} ${detail}`.trim(),
      }
    }
    const parsed = (await response.json()) as Partial<ShellOutcome>
    return {
      status: parsed.status === 'completed' || parsed.status === 'timeout' ? parsed.status : 'failed',
      exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : null,
      output: typeof parsed.output === 'string' ? parsed.output : '',
    }
  } catch (error) {
    return {
      status: 'failed',
      exitCode: null,
      output: `The workspace shell could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
