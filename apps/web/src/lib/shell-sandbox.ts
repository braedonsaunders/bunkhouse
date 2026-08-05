import 'server-only'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import {
  DEFAULT_PROCESS_PATH,
  ProcessSandboxSupervisor,
  isProcessSandboxSupported,
  type ProcessSandboxExecutionResult,
  type ProcessSandboxExecutionSnapshot,
  type ProcessSandboxNetwork,
  type ProcessSandboxSupervisorStats,
} from '@appkit/process-sandbox'

/**
 * Running a shell command in an agent's workspace — and where that happens.
 *
 * The privileged runner owns the bubblewrap launch, while AppKit's supervisor
 * owns execution identity, timeout/cancellation, bounded evidence, and
 * reattachment. A web request can disappear without taking the command or its
 * result with it; retrying the same ID attaches to the existing execution.
 */

export type ShellExecutionPolicy = {
  network: ProcessSandboxNetwork
  timeoutSeconds: number
  replayRetentionMinutes: number
  outputLimitKb: number
  cpuSeconds: number
  memoryMb: number
  fileSizeMb: number
  processes: number
  openFiles: number
}

export const DEFAULT_SHELL_EXECUTION_POLICY: ShellExecutionPolicy = {
  network: 'host',
  timeoutSeconds: 120,
  replayRetentionMinutes: 15,
  outputLimitKb: 64,
  cpuSeconds: 120,
  memoryMb: 2_048,
  fileSizeMb: 512,
  processes: 64,
  openFiles: 256,
}

export const SHELL_TIMEOUT_MS = DEFAULT_SHELL_EXECUTION_POLICY.timeoutSeconds * 1_000
export const OUTPUT_CAP_BYTES = DEFAULT_SHELL_EXECUTION_POLICY.outputLimitKb * 1_024

export type ShellOutcome = {
  executionId: string
  status: 'completed' | 'failed' | 'timeout'
  exitCode: number | null
  output: string
  outputTruncated: boolean
  startedAt: string
  finishedAt: string
}

export type ShellRuntimeStatus = {
  mode: 'remote' | 'local' | 'unavailable'
  available: boolean
  protocol: 'supervised-v1' | null
  active: number
  retained: number
  lastStartedAt: string | null
  lastFinishedAt: string | null
  lastError: string | null
}

const supervisor = new ProcessSandboxSupervisor({
  defaultTimeoutMs: SHELL_TIMEOUT_MS,
  defaultRetentionMs: DEFAULT_SHELL_EXECUTION_POLICY.replayRetentionMinutes * 60_000,
  maxOutputBytes: OUTPUT_CAP_BYTES,
  maxExecutions: 256,
})

/** Resolve a partial/backward-compatible tenant policy and reject unsafe values. */
export function resolveShellExecutionPolicy(
  value: Partial<ShellExecutionPolicy> | null | undefined,
): ShellExecutionPolicy {
  const policy = { ...DEFAULT_SHELL_EXECUTION_POLICY, ...(value ?? {}) }
  if (policy.network !== 'host' && policy.network !== 'none') {
    throw new Error('Shell network policy must be host or none.')
  }
  return {
    network: policy.network,
    timeoutSeconds: boundedInteger(policy.timeoutSeconds, 10, 600, 'Shell timeout'),
    replayRetentionMinutes: boundedInteger(
      policy.replayRetentionMinutes,
      1,
      1_440,
      'Shell replay retention',
    ),
    outputLimitKb: boundedInteger(policy.outputLimitKb, 16, 1_024, 'Shell output limit'),
    cpuSeconds: boundedInteger(policy.cpuSeconds, 10, 600, 'Shell CPU limit'),
    memoryMb: boundedInteger(policy.memoryMb, 256, 8_192, 'Shell memory limit'),
    fileSizeMb: boundedInteger(policy.fileSizeMb, 16, 2_048, 'Shell file size limit'),
    processes: boundedInteger(policy.processes, 8, 512, 'Shell process limit'),
    openFiles: boundedInteger(policy.openFiles, 32, 2_048, 'Shell open-file limit'),
  }
}

/** Is this path inside that root, on a separator boundary? */
export function insideRoot(root: string, candidate: string): boolean {
  const base = resolve(root)
  const target = resolve(candidate)
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)
}

export async function startSandboxedShell(args: {
  executionId?: string
  home: string
  cwd: string
  command: string
  policy?: Partial<ShellExecutionPolicy>
}): Promise<ProcessSandboxExecutionSnapshot> {
  await mkdir(args.cwd, { recursive: true })
  const policy = resolveShellExecutionPolicy(args.policy)
  return supervisor.start({
    executionId: args.executionId,
    timeoutMs: policy.timeoutSeconds * 1_000,
    retentionMs: policy.replayRetentionMinutes * 60_000,
    maxOutputBytes: policy.outputLimitKb * 1_024,
    process: {
      // `/usr/bin/sh` avoids colliding with bubblewrap's merged-/usr symlink.
      command: '/usr/bin/sh',
      args: ['-lc', args.command],
      cwd: args.cwd,
      writablePaths: [args.home],
      network: policy.network,
      limits: {
        cpuSeconds: policy.cpuSeconds,
        addressSpaceBytes: policy.memoryMb * 1_024 * 1_024,
        fileSizeBytes: policy.fileSizeMb * 1_024 * 1_024,
        processes: policy.processes,
        openFiles: policy.openFiles,
      },
      environment: {
        HOME: args.home,
        PATH: DEFAULT_PROCESS_PATH,
        LANG: 'C.UTF-8',
        TMPDIR: '/tmp',
      },
    },
  })
}

export function shellExecutionSnapshot(
  executionId: string,
  afterSequence = 0,
): ProcessSandboxExecutionSnapshot | null {
  return supervisor.snapshot(executionId, afterSequence)
}

export function waitForShellExecution(
  executionId: string,
  afterSequence = 0,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<ProcessSandboxExecutionSnapshot | null> {
  return supervisor.waitForUpdate(executionId, afterSequence, options)
}

export function cancelShellExecution(executionId: string): boolean {
  return supervisor.cancel(executionId)
}

export function disposeShellExecution(executionId: string): Promise<boolean> {
  return supervisor.dispose(executionId)
}

export function shellSupervisorStats(): ProcessSandboxSupervisorStats {
  return supervisor.stats()
}

export async function runSandboxedShell(args: {
  executionId?: string
  home: string
  cwd: string
  command: string
  policy?: Partial<ShellExecutionPolicy>
  /** Compatibility for startup probes; tenant policy otherwise owns this. */
  timeoutMs?: number
}): Promise<ShellOutcome> {
  const policy = resolveShellExecutionPolicy({
    ...args.policy,
    ...(args.timeoutMs ? { timeoutSeconds: Math.max(10, Math.ceil(args.timeoutMs / 1_000)) } : {}),
  })
  const started = await startSandboxedShell({ ...args, policy })
  const result = started.result ?? await supervisor.result(started.executionId)
  return shellOutcome(result, policy)
}

/** Where the shell runs, when it does not run here. */
export type ShellRunner = { url: string; token: string } | null

export function configuredRunner(): ShellRunner {
  const url = process.env.BUNKHOUSE_SHELL_URL
  const token = process.env.BUNKHOUSE_SHELL_TOKEN
  if (!url || !token) return null
  return { url: url.replace(/\/$/, ''), token }
}

/** Fetch runner health for the operator-facing settings surface. */
export async function shellRuntimeStatus(): Promise<ShellRuntimeStatus> {
  const runner = configuredRunner()
  if (!runner) {
    const available = isProcessSandboxSupported()
    const stats = supervisor.stats()
    return {
      mode: available ? 'local' : 'unavailable',
      available,
      protocol: available ? 'supervised-v1' : null,
      ...stats,
    }
  }
  try {
    const response = await fetch(`${runner.url}/health`, { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) throw new Error(`health check returned ${response.status}`)
    const body = await response.json() as Partial<ProcessSandboxSupervisorStats> & {
      protocol?: unknown
      ok?: unknown
    }
    if (body.ok !== true || body.protocol !== 'supervised-v1') {
      throw new Error('runner does not support the supervised execution protocol')
    }
    return {
      mode: 'remote',
      available: true,
      protocol: 'supervised-v1',
      active: integerOr(body.active, 0),
      retained: integerOr(body.retained, 0),
      lastStartedAt: stringOrNull(body.lastStartedAt),
      lastFinishedAt: stringOrNull(body.lastFinishedAt),
      lastError: stringOrNull(body.lastError),
    }
  } catch (error) {
    return {
      mode: 'remote',
      available: false,
      protocol: null,
      active: 0,
      retained: 0,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastError: errorMessage(error),
    }
  }
}

/**
 * Start remotely, then long-poll by execution ID. Transient disconnects only
 * repeat an idempotent start or resume after the last observed sequence; they
 * never launch a duplicate command or lose the retained final result.
 */
export async function runShellRemotely(
  runner: { url: string; token: string },
  body: {
    home: string
    cwd: string
    command: string
    policy?: Partial<ShellExecutionPolicy>
    executionId?: string
  },
  dependencies: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<ShellOutcome> {
  const request = dependencies.fetch ?? fetch
  const now = dependencies.now ?? Date.now
  const policy = resolveShellExecutionPolicy(body.policy)
  const executionId = body.executionId ?? randomUUID()
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${runner.token}`,
  }
  const deadline = now() + policy.timeoutSeconds * 1_000 + 45_000
  let started: ProcessSandboxExecutionSnapshot | null = null

  for (let attempt = 0; attempt < 3 && !started; attempt += 1) {
    try {
      const response = await request(`${runner.url}/executions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, executionId, policy }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) return refusedOutcome(executionId, response)
      started = await response.json() as ProcessSandboxExecutionSnapshot
    } catch (error) {
      if (attempt === 2) return unreachableOutcome(executionId, error)
    }
  }
  if (!started) return unreachableOutcome(executionId, 'No start response.')

  let sequence = started.latestSequence
  if (started.result) return shellOutcome(started.result, policy)
  while (now() < deadline) {
    try {
      const response = await request(
        `${runner.url}/executions/${encodeURIComponent(executionId)}?after=${sequence}`,
        { headers, signal: AbortSignal.timeout(30_000) },
      )
      if (response.status === 404) {
        return failedOutcome(executionId, 'The workspace shell result expired before it was collected.')
      }
      if (!response.ok) return refusedOutcome(executionId, response)
      const update = await response.json() as ProcessSandboxExecutionSnapshot
      sequence = Math.max(sequence, update.latestSequence)
      if (update.result) return shellOutcome(update.result, policy)
    } catch {
      // The execution is independent from this request. Reattach until the
      // command's timeout plus collection grace has elapsed.
      await delay(250)
    }
  }

  await request(`${runner.url}/executions/${encodeURIComponent(executionId)}`, {
    method: 'DELETE',
    headers,
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined)
  return failedOutcome(executionId, 'The workspace shell stopped responding after its execution deadline.')
}

function shellOutcome(
  result: ProcessSandboxExecutionResult,
  policy: ShellExecutionPolicy,
): ShellOutcome {
  const timedOut = result.status === 'timed_out'
  return {
    executionId: result.executionId,
    status: result.status === 'completed' ? 'completed' : timedOut ? 'timeout' : 'failed',
    exitCode: result.exitCode,
    output: result.output + (timedOut ? `\n[killed after ${policy.timeoutSeconds}s]` : ''),
    outputTruncated: result.outputTruncated,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
  }
}

async function refusedOutcome(executionId: string, response: Response): Promise<ShellOutcome> {
  const detail = (await response.text().catch(() => '')).slice(0, 300)
  return failedOutcome(
    executionId,
    `The workspace shell refused this: ${response.status} ${detail}`.trim(),
  )
}

function unreachableOutcome(executionId: string, error: unknown): ShellOutcome {
  return failedOutcome(
    executionId,
    `The workspace shell could not be reached: ${errorMessage(error)}`,
  )
}

function failedOutcome(executionId: string, output: string): ShellOutcome {
  const timestamp = new Date().toISOString()
  return {
    executionId,
    status: 'failed',
    exitCode: null,
    output,
    outputTruncated: false,
    startedAt: timestamp,
    finishedAt: timestamp,
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a whole number from ${minimum} to ${maximum}.`)
  }
  return value
}

function integerOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}
