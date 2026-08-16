import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import sharp from 'sharp'
import { z } from 'zod'
import { ABILITY_FRAME_KEY, defineAbility, type Ability, type AbilityFrame } from '@bunkhouse/runtime'
import {
  backgroundJobs,
  deskEvents,
  deskSessions,
  people,
  tenantSettings,
  WORKSPACE_POLICY_KEY,
  type DeskLedgerEventDetail,
  type DeskLedgerEventKind,
  type WorkspacePolicySettings,
} from '../db/schema'
import { db } from '../db/client'
import { saveFile } from './files'
import { AGENT_SCREEN_HEIGHT, AGENT_SCREEN_WIDTH } from './agent-screen'
import { getDeskPolicy, type DeskFeatures, type DeskPolicy } from './desk-policy'

/**
 * The desk: each agent's own Debian machine — a terminal, a filesystem,
 * arbitrary software, and (only when genuinely needed) a real screen, all one
 * machine with one identity (docs/agent-desk.md). This module is bunkhouse's
 * side of the AppKit boundary: the desk-runner owns the mechanism (booting
 * microVMs, vsock, the compositor) and this module owns the POLICY and the
 * RECORD — which desk an agent gets, what the dial governs, and the one
 * append-only desk_sessions/desk_events ledger everything lands in (§3.19).
 *
 * Fail closed, exactly like the browser and the shell before it: with no
 * runner configured there is no machine, and none of these abilities are
 * offered at all. There is deliberately no local fallback — KVM never exists
 * in the app container, and a degraded desk would misrepresent the product
 * worse than omitting it (§3.23).
 *
 * Governance note (§3.22): per-command approval is not enforced here because
 * it would enforce nothing — an agent with a terminal scripts around it in
 * one line. The `sandbox` dial gates having the machine, the `desktop` dial
 * gates the screen, and real enforcement lives at the exits (the egress
 * proxy, what is mounted, this ledger, and approvals on outcomes).
 */

type PersonRow = typeof people.$inferSelect

// ---------------------------------------------------------------------------
// Shell execution policy — the bounded per-tenant limits, formerly in
// shell-sandbox.ts. The desk applies timeout and output caps; memory/cpu now
// bound the whole machine (desk policy) rather than one process.
// ---------------------------------------------------------------------------

export type ShellExecutionPolicy = {
  network: 'host' | 'none'
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

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a whole number from ${minimum} to ${maximum}.`)
  }
  return value
}

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

// ---------------------------------------------------------------------------
// The runner: where desks actually live
// ---------------------------------------------------------------------------

export type DeskRunner = { url: string; token: string }

export function configuredDeskRunner(): DeskRunner | null {
  const url = process.env.BUNKHOUSE_DESK_URL
  const token = process.env.BUNKHOUSE_DESK_TOKEN
  if (!url || !token) return null
  return { url: url.replace(/\/$/, ''), token }
}

/**
 * Fail-closed capability detection: a configured runner IS the support. The
 * app container never has KVM, so there is no local arm to probe — with no
 * runner, agents have no machine and the abilities are withheld entirely.
 */
export function deskSupported(): boolean {
  return configuredDeskRunner() !== null
}

export type DeskRuntimeStatus = {
  mode: 'remote' | 'unavailable'
  available: boolean
  protocol: 'desk-v1' | null
  resident: number
  queued: number
  capacity: number
  suspended: number
  lastStartedAt: string | null
  lastSuspendedAt: string | null
  lastError: string | null
}

/** Fetch runner health for the operator-facing settings surface. */
export async function deskRuntimeStatus(deps: DeskClientDeps = {}): Promise<DeskRuntimeStatus> {
  const request = deps.fetch ?? fetch
  const runner = deps.runner ?? configuredDeskRunner()
  const empty = {
    resident: 0,
    queued: 0,
    capacity: 0,
    suspended: 0,
    lastStartedAt: null,
    lastSuspendedAt: null,
  }
  if (!runner) {
    return { mode: 'unavailable', available: false, protocol: null, ...empty, lastError: null }
  }
  try {
    const response = await request(`${runner.url}/health`, { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) throw new Error(`health check returned ${response.status}`)
    const body = (await response.json()) as Record<string, unknown>
    if (body.ok !== true || body.protocol !== 'desk-v1') {
      throw new Error('runner does not speak the desk protocol')
    }
    return {
      mode: 'remote',
      available: true,
      protocol: 'desk-v1',
      resident: integerOr(body.resident, 0),
      queued: integerOr(body.queued, 0),
      capacity: integerOr(body.capacity, 0),
      suspended: integerOr(body.suspended, 0),
      lastStartedAt: stringOrNull(body.lastStartedAt),
      lastSuspendedAt: stringOrNull(body.lastSuspendedAt),
      lastError: stringOrNull(body.lastError),
    }
  } catch (error) {
    return { mode: 'remote', available: false, protocol: null, ...empty, lastError: describeError(error) }
  }
}

// ---------------------------------------------------------------------------
// Identity and paths inside the guest
// ---------------------------------------------------------------------------

/**
 * One desk per (tenant, person), forever — the lease is per employee, not per
 * run, which is what makes disk state (logins, installs, dotfiles) persist.
 * Hashed because a deskId lands in socket paths and is capped at 64 chars.
 */
export function deskIdFor(tenantId: string, personId: string): string {
  return `d-${createHash('sha256').update(`${tenantId}:${personId}`).digest('hex').slice(0, 40)}`
}

/** The agent's home inside the guest — the workspace IS the guest home now. */
export const GUEST_HOME = '/home/agent'
/** Where the in-guest browser lands downloads, visible to run_shell (Phase 4). */
export const GUEST_DOWNLOADS_DIR = `${GUEST_HOME}/downloads`
/** The in-guest browser's persistent profile — logins survive across runs. */
export const GUEST_BROWSER_PROFILE_DIR = `${GUEST_HOME}/.config/bunkhouse-browser`

/**
 * Resolve a workspace-relative path to its absolute guest path, refusing
 * anything that escapes the home. Pure, and the one gate every file-shaped
 * input passes through before it reaches the guest.
 */
export function guestWorkspacePath(relative: string): string {
  const target = posix.normalize(posix.join(GUEST_HOME, relative))
  if (target !== GUEST_HOME && !target.startsWith(`${GUEST_HOME}/`)) {
    throw new Error('Path escapes the workspace.')
  }
  return target
}

// ---------------------------------------------------------------------------
// The wire protocol client (desk-v1) — mirrored by scripts/desk-runner.mts.
// The runner is deliberately dependency-light and does not import this module,
// so the wire shapes are duplicated there on purpose; change both together.
// ---------------------------------------------------------------------------

export type DeskClientDeps = {
  fetch?: typeof fetch
  now?: () => number
  runner?: DeskRunner
}

export type DeskExecOutcome = {
  executionId: string
  status: 'completed' | 'failed' | 'timeout'
  exitCode: number | null
  signal: string | null
  output: string
  outputTruncated: boolean
  startedAt: string
  finishedAt: string
}

type RunnerExecResult = {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  truncated: boolean
  timedOut?: boolean
  startedAt: string
  finishedAt: string
}

type RunnerExecSnapshot = { executionId: string; done: boolean; result: RunnerExecResult | null }

export type DeskRunnerEvent = {
  seq: number
  kind: string
  at: string
  detail: Record<string, unknown>
}

export type DeskObservationView = {
  png: string
  width: number
  height: number
  a11y: unknown
  windows: { id: string; title: string; appId: string | null }[]
  focused: { id: string; title: string; appId: string | null } | null
}

function headers(runner: DeskRunner): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${runner.token}` }
}

async function runnerPost<T>(
  runner: DeskRunner,
  deps: DeskClientDeps,
  path: string,
  body: unknown,
  timeoutMs = 30_000,
): Promise<T> {
  const request = deps.fetch ?? fetch
  const response = await request(`${runner.url}${path}`, {
    method: 'POST',
    headers: headers(runner),
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    throw new Error(`The desk runner refused ${path}: ${response.status} ${detail}`.trim())
  }
  return (await response.json()) as T
}

async function runnerGet<T>(
  runner: DeskRunner,
  deps: DeskClientDeps,
  path: string,
  timeoutMs = 30_000,
): Promise<T> {
  const request = deps.fetch ?? fetch
  const response = await request(`${runner.url}${path}`, {
    headers: headers(runner),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    throw new Error(`The desk runner refused ${path}: ${response.status} ${detail}`.trim())
  }
  return (await response.json()) as T
}

/** Lease (start or resume) this agent's desk. Idempotent; renews when resident. */
export async function leaseDesk(
  args: { deskId: string; memoryMb: number; vcpus: number; leaseMs: number },
  deps: DeskClientDeps = {},
): Promise<void> {
  const runner = deps.runner ?? configuredDeskRunner()
  if (!runner) throw new Error('No desk runner is configured.')
  await runnerPost(runner, deps, `/desks/${encodeURIComponent(args.deskId)}/lease`, args, 60_000)
}

/**
 * Run one command on the desk. Start is idempotent by execution id and the
 * result is collected by long-poll, exactly the shape the retired shell
 * runner used: a transient disconnect repeats an idempotent start or resumes
 * the poll — it never launches a duplicate command or loses the result.
 */
export async function execOnDesk(
  args: {
    deskId: string
    executionId?: string
    command: readonly string[]
    cwd?: string
    env?: Record<string, string>
    timeoutMs: number
    outputLimitKb: number
  },
  deps: DeskClientDeps = {},
): Promise<DeskExecOutcome> {
  const runner = deps.runner ?? configuredDeskRunner()
  if (!runner) throw new Error('No desk runner is configured.')
  const request = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const executionId = args.executionId ?? randomUUID()
  const deadline = now() + args.timeoutMs + 45_000
  const body = JSON.stringify({
    executionId,
    command: args.command,
    cwd: args.cwd,
    env: args.env,
    timeoutMs: args.timeoutMs,
    outputLimitKb: args.outputLimitKb,
  })

  let started: RunnerExecSnapshot | null = null
  for (let attempt = 0; attempt < 3 && !started; attempt += 1) {
    try {
      const response = await request(
        `${runner.url}/desks/${encodeURIComponent(args.deskId)}/executions`,
        { method: 'POST', headers: headers(runner), body, signal: AbortSignal.timeout(10_000) },
      )
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300)
        return failedExec(executionId, `The desk refused this command: ${response.status} ${detail}`.trim())
      }
      started = (await response.json()) as RunnerExecSnapshot
    } catch (error) {
      if (attempt === 2) return failedExec(executionId, `The desk could not be reached: ${describeError(error)}`)
    }
  }
  if (!started) return failedExec(executionId, 'The desk could not be reached: no start response.')
  if (started.result) return execOutcome(executionId, started.result)

  while (now() < deadline) {
    try {
      const response = await request(
        `${runner.url}/executions/${encodeURIComponent(executionId)}?wait=1`,
        { headers: headers(runner), signal: AbortSignal.timeout(30_000) },
      )
      if (response.status === 404) {
        return failedExec(executionId, 'The desk command result expired before it was collected.')
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300)
        return failedExec(executionId, `The desk refused this command: ${response.status} ${detail}`.trim())
      }
      const update = (await response.json()) as RunnerExecSnapshot
      if (update.result) return execOutcome(executionId, update.result)
    } catch {
      // The execution is independent of this request; reattach until the
      // command's own deadline plus collection grace has elapsed.
      await delay(250)
    }
  }
  return failedExec(executionId, 'The desk stopped responding after the execution deadline.')
}

function execOutcome(executionId: string, result: RunnerExecResult): DeskExecOutcome {
  const timedOut = result.timedOut === true
  return {
    executionId,
    status: timedOut ? 'timeout' : result.exitCode === 0 ? 'completed' : 'failed',
    exitCode: result.exitCode,
    signal: result.signal,
    output: [result.stdout, result.stderr].filter(Boolean).join('\n'),
    outputTruncated: result.truncated,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
  }
}

function failedExec(executionId: string, output: string): DeskExecOutcome {
  const timestamp = new Date().toISOString()
  return {
    executionId,
    status: 'failed',
    exitCode: null,
    signal: null,
    output,
    outputTruncated: false,
    startedAt: timestamp,
    finishedAt: timestamp,
  }
}

/** Buffered runner events since a cursor — the ledger drains these. */
export async function fetchDeskEvents(
  deskId: string,
  after: number,
  deps: DeskClientDeps = {},
): Promise<DeskRunnerEvent[]> {
  const runner = deps.runner ?? configuredDeskRunner()
  if (!runner) return []
  const body = await runnerGet<{ events: DeskRunnerEvent[] }>(
    runner,
    deps,
    `/desks/${encodeURIComponent(deskId)}/events?after=${after}`,
    10_000,
  )
  return Array.isArray(body.events) ? body.events : []
}

async function observeDesk(deskId: string, deps: DeskClientDeps): Promise<DeskObservationView> {
  const runner = deps.runner ?? configuredDeskRunner()
  if (!runner) throw new Error('No desk runner is configured.')
  return runnerGet<DeskObservationView>(runner, deps, `/desks/${encodeURIComponent(deskId)}/screen/observe`)
}

/**
 * Ensure the in-guest browser is running (headless Chromium with the
 * persistent profile) and return the websocket endpoint puppeteer connects
 * to — the runner relays CDP into the guest. The token rides the query string
 * because a websocket dial cannot carry our bearer header everywhere.
 */
export async function connectDeskBrowser(
  args: { tenantId: string; personId: string },
  deps: DeskClientDeps = {},
): Promise<{ browserWSEndpoint: string }> {
  const runner = deps.runner ?? configuredDeskRunner()
  if (!runner) throw new Error('No desk runner is configured.')
  const deskId = deskIdFor(args.tenantId, args.personId)
  const policy = await getDeskPolicy(args.tenantId)
  await leaseDesk(
    { deskId, memoryMb: policy.memoryMb, vcpus: policy.vcpus, leaseMs: policy.leaseMs },
    { ...deps, runner },
  )
  const { path } = await runnerPost<{ path: string }>(
    runner,
    deps,
    `/desks/${encodeURIComponent(deskId)}/browser`,
    {},
    60_000,
  )
  const base = runner.url.replace(/^http/, 'ws')
  return {
    browserWSEndpoint:
      `${base}/desks/${encodeURIComponent(deskId)}/browser${path}` +
      `?token=${encodeURIComponent(runner.token)}`,
  }
}

// ---------------------------------------------------------------------------
// The ledger — desk_sessions + desk_events, injectable for tests
// ---------------------------------------------------------------------------

export type DeskLedgerStore = {
  /** Find-or-create the run's session row; reopening preserves seq. */
  openSession(args: { tenantId: string; personId: string; runId: string }): Promise<{ id: string; seq: number }>
  appendEvent(args: {
    tenantId: string
    sessionId: string
    seq: number
    kind: DeskLedgerEventKind
    detail: DeskLedgerEventDetail
    screenshotFileId?: string | null
    at?: Date
  }): Promise<void>
  markScreenOpened(args: { tenantId: string; sessionId: string; reason: string }): Promise<void>
  markSessionStatus(args: { tenantId: string; sessionId: string; status: 'ended' | 'failed' }): Promise<void>
  upsertJobStart(args: {
    tenantId: string
    personId: string
    sessionId: string
    jobId: string
    command: string
  }): Promise<void>
  markJobExit(args: { tenantId: string; sessionId: string; jobId: string; exitCode: number | null }): Promise<void>
}

/** The real store. Every write goes through the tenant context, like everything. */
export function dbDeskLedgerStore(): DeskLedgerStore {
  return {
    async openSession({ tenantId, personId, runId }) {
      const app = db()
      return app.withTenant(tenantId, async () => {
        const [existing] = await app.db
          .select({ id: deskSessions.id })
          .from(deskSessions)
          .where(and(eq(deskSessions.tenantId, tenantId), eq(deskSessions.runId, runId)))
        if (existing) {
          const [last] = await app.db
            .select({ seq: deskEvents.seq })
            .from(deskEvents)
            .where(and(eq(deskEvents.tenantId, tenantId), eq(deskEvents.sessionId, existing.id)))
            .orderBy(desc(deskEvents.seq))
            .limit(1)
          await app.db
            .update(deskSessions)
            .set({ status: 'active', endedAt: null, updatedAt: new Date() })
            .where(eq(deskSessions.id, existing.id))
          return { id: existing.id, seq: last?.seq ?? 0 }
        }
        const [created] = await app.db
          .insert(deskSessions)
          .values({ tenantId, personId, runId, status: 'active' })
          .returning({ id: deskSessions.id })
        if (!created) throw new Error('The desk session could not be recorded.')
        return { id: created.id, seq: 0 }
      })
    },
    async appendEvent(args) {
      const app = db()
      await app.withTenant(args.tenantId, async () => {
        await app.db.insert(deskEvents).values({
          tenantId: args.tenantId,
          sessionId: args.sessionId,
          seq: args.seq,
          kind: args.kind,
          detail: args.detail,
          screenshotFileId: args.screenshotFileId ?? null,
          at: args.at ?? new Date(),
        })
      })
    },
    async markScreenOpened({ tenantId, sessionId, reason }) {
      const app = db()
      await app.withTenant(tenantId, async () => {
        await app.db
          .update(deskSessions)
          .set({ screenOpenedAt: new Date(), screenReason: reason, updatedAt: new Date() })
          .where(eq(deskSessions.id, sessionId))
      })
    },
    async markSessionStatus({ tenantId, sessionId, status }) {
      const app = db()
      await app.withTenant(tenantId, async () => {
        await app.db
          .update(deskSessions)
          .set({ status, endedAt: new Date(), updatedAt: new Date() })
          .where(eq(deskSessions.id, sessionId))
      })
    },
    async upsertJobStart({ tenantId, personId, sessionId, jobId, command }) {
      const app = db()
      await app.withTenant(tenantId, async () => {
        await app.db
          .insert(backgroundJobs)
          .values({ tenantId, personId, sessionId, jobId, command, status: 'running' })
          .onConflictDoNothing({ target: [backgroundJobs.sessionId, backgroundJobs.jobId] })
      })
    },
    async markJobExit({ tenantId, sessionId, jobId, exitCode }) {
      const app = db()
      await app.withTenant(tenantId, async () => {
        await app.db
          .update(backgroundJobs)
          .set({ status: 'exited', exitedAt: new Date(), exitCode, updatedAt: new Date() })
          .where(and(eq(backgroundJobs.sessionId, sessionId), eq(backgroundJobs.jobId, jobId)))
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Live per-run state — one session row per run, one seq allocator shared by
// everything that writes to it (shell, screen, AND the browser driver).
// ---------------------------------------------------------------------------

type LiveDesk = {
  sessionId: string
  tenantId: string
  personId: string
  runId: string
  deskId: string
  /** Ledger events already written for this session; the next is seq + 1. */
  seq: number
  /** Screen steps spent this screen session — the §3.18 budget counter. */
  screenSteps: number
  screenOpen: boolean
  /** Runner-event cursor already drained into the ledger. */
  drainCursor: number
  /** Serializes ledger writes so two concurrent tool calls never race a seq. */
  chain: Promise<unknown>
}

type DeskRuntimeGlobal = typeof globalThis & { __bunkhouseDeskSessions?: Map<string, Promise<LiveDesk>> }
const deskRuntime = globalThis as DeskRuntimeGlobal

function liveDesks(): Map<string, Promise<LiveDesk>> {
  return (deskRuntime.__bunkhouseDeskSessions ??= new Map())
}

async function getLiveDesk(ctx: DeskContext): Promise<LiveDesk> {
  const map = liveDesks()
  const pending = map.get(ctx.runId)
  if (pending) return pending
  const started = (async (): Promise<LiveDesk> => {
    const row = await ctx.store.openSession({ tenantId: ctx.tenantId, personId: ctx.personId, runId: ctx.runId })
    return {
      sessionId: row.id,
      tenantId: ctx.tenantId,
      personId: ctx.personId,
      runId: ctx.runId,
      deskId: deskIdFor(ctx.tenantId, ctx.personId),
      seq: row.seq,
      screenSteps: 0,
      screenOpen: false,
      drainCursor: 0,
      chain: Promise.resolve(),
    }
  })()
  map.set(ctx.runId, started)
  try {
    return await started
  } catch (error) {
    map.delete(ctx.runId)
    throw error
  }
}

/** Append one event under the session's serialized seq allocator. */
function appendSerialized(
  ctx: DeskContext,
  live: LiveDesk,
  kind: DeskLedgerEventKind,
  detail: DeskLedgerEventDetail,
  screenshotFileId?: string | null,
): Promise<number> {
  const next = live.chain.then(async () => {
    const seq = live.seq + 1
    live.seq = seq
    await ctx.store.appendEvent({
      tenantId: ctx.tenantId,
      sessionId: live.sessionId,
      seq,
      kind,
      detail,
      screenshotFileId: screenshotFileId ?? null,
    })
    return seq
  })
  // The chain never rejects twice: a failed append surfaces to its caller and
  // the chain itself carries on.
  live.chain = next.catch(() => undefined)
  return next
}

/**
 * The browser driver's door into this same ledger: browser-use records its
 * steps here so one run has ONE session and one interleaved stream — the
 * whole point of §3.19. Returns the seq the event landed at.
 */
export async function recordDeskLedgerEvent(args: {
  tenantId: string
  personId: string
  runId: string
  kind: DeskLedgerEventKind
  detail: DeskLedgerEventDetail
  screenshotFileId?: string | null
  store?: DeskLedgerStore
}): Promise<{ sessionId: string; seq: number }> {
  const ctx = deskContext({
    tenantId: args.tenantId,
    personId: args.personId,
    runId: args.runId,
    deps: args.store ? { store: args.store } : {},
  })
  const live = await getLiveDesk(ctx)
  const seq = await appendSerialized(ctx, live, args.kind, args.detail, args.screenshotFileId)
  return { sessionId: live.sessionId, seq }
}

/**
 * Stamp the run's desk session ended. Idempotent; run teardown calls it. The
 * DESK stays resident — the lease and the machine outlive the run; only the
 * session (the run's chapter of the record) closes.
 */
export async function closeDeskSession(runId: string): Promise<void> {
  const map = liveDesks()
  const pending = map.get(runId)
  if (!pending) return
  map.delete(runId)
  const live = await pending.catch(() => null)
  if (!live) return
  const ctx = deskContext({ tenantId: live.tenantId, personId: live.personId, runId, deps: {} })
  await drainRunnerEvents(ctx, live).catch(() => undefined)
  await ctx.store.markSessionStatus({ tenantId: live.tenantId, sessionId: live.sessionId, status: 'ended' })
}

// ---------------------------------------------------------------------------
// The drain: runner-buffered events → the ledger. The runner owns no record
// (AppKit boundary: mechanism there, record here); bunkhouse pulls what the
// machine observed and persists it. Input and shell events are authored by
// the ability path (which has the richer context — output, screenshots, the
// budget); the drain persists what only the machine sees: job lifecycles,
// focus changes the guest emitted, expired handovers, egress denials.
// ---------------------------------------------------------------------------

const DRAINED_KINDS: ReadonlySet<string> = new Set([
  'job_start',
  'job_exit',
  'window_focus',
  'handover_end',
  'egress_blocked',
  'shared_write',
])

async function drainRunnerEvents(ctx: DeskContext, live: LiveDesk): Promise<void> {
  const events = await fetchDeskEvents(live.deskId, live.drainCursor, ctx.deps).catch(() => [])
  for (const event of events) {
    if (event.seq <= live.drainCursor) continue
    live.drainCursor = event.seq
    if (!DRAINED_KINDS.has(event.kind)) continue
    const detail = (event.detail ?? {}) as DeskLedgerEventDetail
    await appendSerialized(ctx, live, event.kind as DeskLedgerEventKind, detail)
    if (event.kind === 'job_start' && detail.jobId && detail.command) {
      await ctx.store.upsertJobStart({
        tenantId: ctx.tenantId,
        personId: ctx.personId,
        sessionId: live.sessionId,
        jobId: detail.jobId,
        command: detail.command,
      })
    }
    if (event.kind === 'job_exit' && detail.jobId) {
      await ctx.store.markJobExit({
        tenantId: ctx.tenantId,
        sessionId: live.sessionId,
        jobId: detail.jobId,
        exitCode: detail.exitCode ?? null,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Context assembly and shared helpers
// ---------------------------------------------------------------------------

export type DeskAbilityDeps = {
  fetch?: typeof fetch
  now?: () => number
  runner?: DeskRunner
  store?: DeskLedgerStore
  policy?: (tenantId: string) => Promise<DeskPolicy>
  shellPolicy?: (tenantId: string) => Promise<ShellExecutionPolicy>
  saveScreenshot?: (args: {
    tenantId: string
    personId: string
    runId: string
    seq: number
    bytes: Uint8Array
  }) => Promise<string | null>
}

type DeskContext = {
  tenantId: string
  personId: string
  runId: string
  store: DeskLedgerStore
  deps: DeskClientDeps
  policy: () => Promise<DeskPolicy>
  shellPolicy: () => Promise<ShellExecutionPolicy>
  saveScreenshot: NonNullable<DeskAbilityDeps['saveScreenshot']>
}

async function tenantShellPolicy(tenantId: string): Promise<ShellExecutionPolicy> {
  const app = db()
  const [row] = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ value: tenantSettings.value })
      .from(tenantSettings)
      .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, WORKSPACE_POLICY_KEY))),
  )
  const stored = row?.value as Partial<WorkspacePolicySettings> | undefined
  return resolveShellExecutionPolicy(stored?.shell)
}

function deskContext(args: {
  tenantId: string
  personId: string
  runId: string
  deps: DeskAbilityDeps
}): DeskContext {
  const deps = args.deps
  return {
    tenantId: args.tenantId,
    personId: args.personId,
    runId: args.runId,
    store: deps.store ?? dbDeskLedgerStore(),
    deps: {
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.runner ? { runner: deps.runner } : {}),
    },
    policy: () => (deps.policy ?? getDeskPolicy)(args.tenantId),
    shellPolicy: () => (deps.shellPolicy ?? tenantShellPolicy)(args.tenantId),
    saveScreenshot:
      deps.saveScreenshot ??
      (async ({ tenantId, personId, runId, seq, bytes }) => {
        try {
          const file = await saveFile({
            tenantId,
            personId,
            runId,
            kind: 'recording',
            filename: `desk-step-${String(seq).padStart(3, '0')}.png`,
            contentType: 'image/png',
            bytes,
          })
          return file.id
        } catch {
          return null
        }
      }),
  }
}

async function ensureDesk(ctx: DeskContext): Promise<LiveDesk> {
  const live = await getLiveDesk(ctx)
  const policy = await ctx.policy()
  await leaseDesk(
    { deskId: live.deskId, memoryMb: policy.memoryMb, vcpus: policy.vcpus, leaseMs: policy.leaseMs },
    ctx.deps,
  )
  return live
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() || 'no reason given'
}

function integerOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

// ---------------------------------------------------------------------------
// The screen: observation frames for the model, budget, recording
// ---------------------------------------------------------------------------

/** Same discipline as the browser: shrink frames before a model sees them. */
const MODEL_FRAME_WIDTH = 1024
const MODEL_FRAME_QUALITY = 55
const MODEL_FRAME_MAX_BYTES = 200_000

async function frameForModel(png: Uint8Array): Promise<{ mediaType: string; data: string } | null> {
  try {
    const shrunk = await sharp(Buffer.from(png))
      .resize({ width: MODEL_FRAME_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: MODEL_FRAME_QUALITY })
      .toBuffer()
    if (shrunk.byteLength > MODEL_FRAME_MAX_BYTES) return null
    return { mediaType: 'image/jpeg', data: shrunk.toString('base64') }
  } catch {
    return null
  }
}

function shownFrame(frame: { mediaType: string; data: string } | null): Record<string, AbilityFrame> {
  if (!frame) return {}
  return {
    [ABILITY_FRAME_KEY]: {
      ...frame,
      label:
        'This is your desktop screen right now. Read the picture before you decide what happened — it, not your expectation, is what the screen actually shows.',
    },
  }
}

/**
 * Observe the screen, file the frame, append the event, hand the picture
 * back. One helper because every desktop step does exactly this — the
 * doctrine that gated abilities are recorded is not per-ability discipline,
 * it is the shape of the loop.
 */
async function observeRecordShow(
  ctx: DeskContext,
  live: LiveDesk,
  kind: DeskLedgerEventKind,
  detail: DeskLedgerEventDetail,
): Promise<Record<string, unknown>> {
  let observation: DeskObservationView | null = null
  let observeError: string | null = null
  try {
    observation = await observeDesk(live.deskId, ctx.deps)
  } catch (error) {
    observeError = describeError(error)
  }
  const bytes = observation ? Buffer.from(observation.png, 'base64') : null
  const seqForFile = live.seq + 1
  const fileId = bytes
    ? await ctx.saveScreenshot({
        tenantId: ctx.tenantId,
        personId: ctx.personId,
        runId: ctx.runId,
        seq: seqForFile,
        bytes,
      })
    : null
  const recorded: DeskLedgerEventDetail = {
    ...detail,
    ...(observeError ? { screenshotError: `The screen could not be observed: ${observeError}` } : {}),
  }
  await appendSerialized(ctx, live, kind, recorded, fileId)
  await drainRunnerEvents(ctx, live).catch(() => undefined)
  const frame = bytes ? await frameForModel(bytes) : null
  const policy = await ctx.policy()
  return {
    ...(observation
      ? {
          windows: observation.windows,
          focused: observation.focused,
          ...(observation.a11y ? { accessibilityTree: observation.a11y } : {}),
        }
      : { error: `The screen could not be observed: ${observeError ?? 'no observation'}` }),
    ...(fileId ? { fileId } : {}),
    step: live.screenSteps,
    stepsLeft: Math.max(0, policy.screenStepCeiling - live.screenSteps),
    ...shownFrame(frame),
  }
}

async function screenBudgetSpent(ctx: DeskContext, live: LiveDesk): Promise<Record<string, string> | null> {
  const policy = await ctx.policy()
  if (live.screenSteps < policy.screenStepCeiling) return null
  return {
    error:
      `This screen session has used all ${policy.screenStepCeiling} of its steps. ` +
      'Close the desktop and finish with what you have, or report where you got to.',
  }
}

const NO_SCREEN = { error: 'No screen is open — call open_desktop (with a reason) first.' } as const

async function runnerScreenPost(
  ctx: DeskContext,
  live: LiveDesk,
  path: string,
  body: unknown,
): Promise<void> {
  const runner = ctx.deps.runner ?? configuredDeskRunner()
  if (!runner) throw new Error('No desk runner is configured.')
  await runnerPost(runner, ctx.deps, `/desks/${encodeURIComponent(live.deskId)}${path}`, body)
}

// ---------------------------------------------------------------------------
// run_shell and the workspace file abilities — the headless tier
// ---------------------------------------------------------------------------

const LIST_CAP = 200
const READ_CAP_BYTES = 32 * 1024
/** Publishing moves real bytes; cap the base64 leg at ~6 MB of transport. */
const PUBLISH_CAP_KB = 6_144

async function runShellOnDesk(
  ctx: DeskContext,
  args: { command: string; cwd: string },
): Promise<{ status: 'completed' | 'failed' | 'timeout'; exitCode: number | null; output: string }> {
  const cwd = guestWorkspacePath(args.cwd)
  const live = await ensureDesk(ctx)
  const shell = await ctx.shellPolicy()
  const outcome = await execOnDesk(
    {
      deskId: live.deskId,
      command: ['/bin/sh', '-lc', args.command],
      cwd,
      timeoutMs: shell.timeoutSeconds * 1_000,
      outputLimitKb: shell.outputLimitKb,
    },
    ctx.deps,
  )
  const cap = shell.outputLimitKb * 1_024
  const output = outcome.output.length > cap ? outcome.output.slice(0, cap) : outcome.output
  await appendSerialized(ctx, live, 'shell_command', {
    command: args.command,
    cwd: args.cwd,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    output,
    outputTruncated: outcome.outputTruncated || output.length < outcome.output.length,
  })
  await drainRunnerEvents(ctx, live).catch(() => undefined)
  return { status: outcome.status, exitCode: outcome.exitCode, output }
}

async function execQuietly(
  ctx: DeskContext,
  command: readonly string[],
  options: { cwd?: string; timeoutMs?: number; outputLimitKb?: number } = {},
): Promise<DeskExecOutcome> {
  const live = await ensureDesk(ctx)
  return execOnDesk(
    {
      deskId: live.deskId,
      command,
      cwd: options.cwd ?? GUEST_HOME,
      timeoutMs: options.timeoutMs ?? 30_000,
      outputLimitKb: options.outputLimitKb ?? 256,
    },
    ctx.deps,
  )
}

// ---------------------------------------------------------------------------
// The abilities
// ---------------------------------------------------------------------------

/**
 * Everything the desk offers an agent, assembled for one run. Withheld
 * entirely — fail closed — without a configured runner or with the desk
 * feature off; the desktop family additionally requires the desktop feature.
 * The `sandbox` dial governs the machine, the `desktop` dial the screen
 * (§3.21); those are enforced by the governed loop at the call site.
 */
export function deskAbilities(args: {
  tenantId: string
  person: PersonRow
  runId: string
  features: DeskFeatures
  deps?: DeskAbilityDeps
}): Ability[] {
  const { tenantId, person, runId, features } = args
  const deps = args.deps ?? {}
  const runnerConfigured = (deps.runner ?? configuredDeskRunner()) !== null
  if (!runnerConfigured || !features.desk) return []
  const ctx = deskContext({ tenantId, personId: person.id, runId, deps })

  const abilities: Ability[] = [
    defineAbility({
      name: 'run_shell',
      description:
        'Run a shell command on your own Linux machine. Your home folder persists across runs and calls — files you create are there next time, and anything you install stays installed. Output is captured on the record. Use it for real work: organizing files, processing data, running tools, preparing material you then publish and send. Prefer this and your tier-0 abilities (create_document, create_spreadsheet, run_script) over opening a desktop screen — the screen is the expensive tier and most work never needs it.',
      category: 'sandbox',
      inputSchema: z.object({
        command: z.string().describe('The command line, run with /bin/sh -lc'),
        cwd: z.string().default('.').describe('Working folder inside your home'),
      }),
      execute: async ({ command, cwd }) => runShellOnDesk(ctx, { command, cwd }),
    }),
    defineAbility({
      name: 'list_workspace_files',
      description:
        'List the files in your workspace — your machine\'s persistent home folder. Work you saved there in earlier runs and calls is still there.',
      category: null,
      inputSchema: z.object({
        path: z.string().default('.').describe('Folder inside your workspace, e.g. "." or "projects"'),
      }),
      execute: async ({ path }) => {
        const dir = guestWorkspacePath(path)
        const outcome = await execQuietly(ctx, [
          '/usr/bin/find',
          '.',
          '-mindepth',
          '1',
          '-maxdepth',
          '4',
          '-printf',
          '%y\\t%s\\t%T@\\t%P\\n',
        ], { cwd: dir })
        if (outcome.status !== 'completed') {
          return { entries: [], note: `The workspace could not be listed: ${outcome.output.trim() || outcome.status}` }
        }
        const entries: { path: string; kind: 'file' | 'folder'; sizeBytes?: number; modifiedAt?: string }[] = []
        for (const line of outcome.output.split('\n')) {
          if (entries.length >= LIST_CAP) break
          const [type, size, mtime, ...rest] = line.split('\t')
          const rel = rest.join('\t')
          if (!type || !rel) continue
          if (type === 'd') entries.push({ path: rel, kind: 'folder' })
          else if (type === 'f') {
            entries.push({
              path: rel,
              kind: 'file',
              sizeBytes: Number.parseInt(size ?? '0', 10) || 0,
              modifiedAt: new Date(Math.round(Number.parseFloat(mtime ?? '0') * 1000)).toISOString(),
            })
          }
        }
        return { entries, ...(entries.length >= LIST_CAP ? { note: `Listing capped at ${LIST_CAP} entries.` } : {}) }
      },
    }),
    defineAbility({
      name: 'read_workspace_file',
      description: 'Read a text file from your workspace (truncated past 32 KB).',
      category: null,
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const target = guestWorkspacePath(path)
        const outcome = await execQuietly(ctx, ['/usr/bin/head', '-c', String(READ_CAP_BYTES + 1), target], {
          outputLimitKb: 64,
        })
        if (outcome.status !== 'completed') {
          return { found: false, reason: outcome.output.trim() || 'No such file in your workspace.' }
        }
        const truncated = outcome.output.length > READ_CAP_BYTES
        return { found: true, text: outcome.output.slice(0, READ_CAP_BYTES), ...(truncated ? { truncated: true } : {}) }
      },
    }),
    defineAbility({
      name: 'publish_workspace_file',
      description:
        'Publish a file from your workspace to the company file ledger, so it can be attached to email (attachFileIds) and kept on the record. Returns the file id.',
      category: 'file_write',
      inputSchema: z.object({
        path: z.string().describe('The workspace file to publish'),
        filename: z.string().optional().describe('Name the recipient sees; defaults to the file name'),
        contentType: z.string().optional().describe('MIME type; defaults to application/octet-stream'),
      }),
      execute: async ({ path, filename, contentType }) => {
        const target = guestWorkspacePath(path)
        const outcome = await execQuietly(ctx, ['/usr/bin/base64', '-w0', target], {
          outputLimitKb: PUBLISH_CAP_KB,
          timeoutMs: 60_000,
        })
        if (outcome.status !== 'completed') {
          return { published: false, reason: outcome.output.trim() || 'No such file in your workspace.' }
        }
        if (outcome.outputTruncated) {
          return {
            published: false,
            reason: `That file is too large to publish this way (over ~${Math.floor((PUBLISH_CAP_KB * 3) / 4 / 1024)} MB).`,
          }
        }
        const bytes = Buffer.from(outcome.output.trim(), 'base64')
        const record = await saveFile({
          tenantId,
          personId: person.id,
          runId,
          kind: 'document',
          filename: filename ?? path.split('/').pop() ?? 'file',
          contentType: contentType ?? 'application/octet-stream',
          bytes,
        })
        const live = await getLiveDesk(ctx)
        await appendSerialized(ctx, live, 'file_write', { target: path, title: record.filename })
        return { published: true, fileId: record.id, filename: record.filename, sizeBytes: record.sizeBytes }
      },
    }),
  ]

  if (!features.desktop) return abilities

  abilities.push(
    defineAbility({
      name: 'open_desktop',
      description:
        'Start a real desktop screen on your machine — the EXPENSIVE tier, for GUI software with no command line and for work you genuinely cannot do any other way. Climb the ladder first: tier-0 abilities (create_document, create_spreadsheet, run_script) and connectors are better at their jobs than any GUI; the browser abilities handle websites; run_shell handles files and tools. Only when all of those genuinely cannot do it, open the screen — and say why: the reason you give here is recorded and reviewed. Each screen session has a hard step budget, so know what you are there to do before you open it.',
      category: 'desktop',
      inputSchema: z.object({
        reason: z
          .string()
          .min(3)
          .describe('Why this work needs a screen — what you tried or ruled out below it. Recorded.'),
      }),
      execute: async ({ reason }) => {
        const stated = reason?.trim()
        if (!stated || stated.length < 3) {
          return { opened: false, error: 'A screen needs a stated reason. Say why the cheaper tiers cannot do this.' }
        }
        const live = await ensureDesk(ctx)
        try {
          await runnerScreenPost(ctx, live, '/screen/start', {
            width: AGENT_SCREEN_WIDTH,
            height: AGENT_SCREEN_HEIGHT,
          })
        } catch (error) {
          return { opened: false, error: `The screen could not be started: ${describeError(error)}` }
        }
        live.screenOpen = true
        live.screenSteps = 0
        await ctx.store.markScreenOpened({ tenantId, sessionId: live.sessionId, reason: stated })
        const result = await observeRecordShow(ctx, live, 'screen_open', {
          width: AGENT_SCREEN_WIDTH,
          height: AGENT_SCREEN_HEIGHT,
          reason: stated,
        })
        return { opened: true, ...result }
      },
    }),
    defineAbility({
      name: 'close_desktop',
      description:
        'Stop the desktop screen when you are done with GUI work. The machine keeps running headless — your files and shell are unaffected. Close it as soon as the screen work is finished; an open screen is the expensive tier.',
      category: null,
      approval: 'continues',
      inputSchema: z.object({}),
      execute: async () => {
        const live = await getLiveDesk(ctx)
        if (!live.screenOpen) return { closed: false, note: 'No screen is open.' }
        try {
          await runnerScreenPost(ctx, live, '/screen/stop', {})
        } catch (error) {
          return { closed: false, error: `The screen could not be stopped: ${describeError(error)}` }
        }
        live.screenOpen = false
        await appendSerialized(ctx, live, 'screen_close', {})
        return { closed: true }
      },
    }),
    defineAbility({
      name: 'desktop_screenshot',
      description:
        'Look at the desktop screen — a fresh picture, plus the open windows and (when the focused app exposes one) its accessibility tree. Coordinates you pass to click/type/scroll are in this picture\'s pixel space, one to one. The frame is also kept on the run record.',
      category: 'desktop',
      approval: 'continues',
      inputSchema: z.object({}),
      execute: async () => {
        const live = await getLiveDesk(ctx)
        if (!live.screenOpen) return NO_SCREEN
        const spent = await screenBudgetSpent(ctx, live)
        if (spent) return spent
        live.screenSteps += 1
        return observeRecordShow(ctx, live, 'screenshot', {})
      },
    }),
    defineAbility({
      name: 'desktop_click',
      description:
        'Click at a point on the desktop screen. Coordinates are in the pixel space of the last screenshot, one to one. You get a fresh picture back — read it before deciding what happened.',
      category: 'desktop',
      approval: 'continues',
      inputSchema: z.object({
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        button: z.enum(['left', 'middle', 'right']).default('left'),
      }),
      execute: async ({ x, y, button }) => {
        const live = await getLiveDesk(ctx)
        if (!live.screenOpen) return NO_SCREEN
        const spent = await screenBudgetSpent(ctx, live)
        if (spent) return spent
        live.screenSteps += 1
        try {
          await runnerScreenPost(ctx, live, '/screen/input', { action: 'click', x, y, button })
        } catch (error) {
          return { error: `The click did not land: ${describeError(error)}` }
        }
        return observeRecordShow(ctx, live, 'click', { x, y, button })
      },
    }),
    defineAbility({
      name: 'desktop_type',
      description:
        'Type text into whatever has keyboard focus on the desktop. Click the field first. You get a fresh picture back; check that the text actually landed where you meant.',
      category: 'desktop',
      approval: 'continues',
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        const live = await getLiveDesk(ctx)
        if (!live.screenOpen) return NO_SCREEN
        const spent = await screenBudgetSpent(ctx, live)
        if (spent) return spent
        live.screenSteps += 1
        try {
          await runnerScreenPost(ctx, live, '/screen/input', { action: 'type', text })
        } catch (error) {
          return { error: `The text could not be typed: ${describeError(error)}` }
        }
        return observeRecordShow(ctx, live, 'type', { text })
      },
    }),
    defineAbility({
      name: 'desktop_key',
      description:
        'Press a key or combination on the desktop — e.g. "Return", "ctrl+s", "alt+Tab". For plain text use desktop_type.',
      category: 'desktop',
      approval: 'continues',
      inputSchema: z.object({ combo: z.string().describe('Key or combo, e.g. "Return" or "ctrl+shift+t"') }),
      execute: async ({ combo }) => {
        const live = await getLiveDesk(ctx)
        if (!live.screenOpen) return NO_SCREEN
        const spent = await screenBudgetSpent(ctx, live)
        if (spent) return spent
        live.screenSteps += 1
        try {
          await runnerScreenPost(ctx, live, '/screen/input', { action: 'key', combo })
        } catch (error) {
          return { error: `The key could not be pressed: ${describeError(error)}` }
        }
        return observeRecordShow(ctx, live, 'key', { combo })
      },
    }),
    defineAbility({
      name: 'desktop_scroll',
      description:
        'Scroll at a point on the desktop screen. dx/dy are scroll deltas; positive dy scrolls down. Coordinates are in the last screenshot\'s pixel space.',
      category: 'desktop',
      approval: 'continues',
      inputSchema: z.object({
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        dx: z.number().int().default(0),
        dy: z.number().int().default(0),
      }),
      execute: async ({ x, y, dx, dy }) => {
        const live = await getLiveDesk(ctx)
        if (!live.screenOpen) return NO_SCREEN
        const spent = await screenBudgetSpent(ctx, live)
        if (spent) return spent
        live.screenSteps += 1
        try {
          await runnerScreenPost(ctx, live, '/screen/input', { action: 'scroll', x, y, dx, dy })
        } catch (error) {
          return { error: `The scroll did not land: ${describeError(error)}` }
        }
        return observeRecordShow(ctx, live, 'scroll', { x, y, dx, dy })
      },
    }),
    defineAbility({
      name: 'desktop_drag',
      description:
        'Drag from one point to another on the desktop screen — for moving windows, selecting text, drag-and-drop. Coordinates are in the last screenshot\'s pixel space.',
      category: 'desktop',
      approval: 'continues',
      inputSchema: z.object({
        from: z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }),
        to: z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }),
      }),
      execute: async ({ from, to }) => {
        const live = await getLiveDesk(ctx)
        if (!live.screenOpen) return NO_SCREEN
        const spent = await screenBudgetSpent(ctx, live)
        if (spent) return spent
        live.screenSteps += 1
        try {
          await runnerScreenPost(ctx, live, '/screen/input', { action: 'drag', from, to })
        } catch (error) {
          return { error: `The drag did not land: ${describeError(error)}` }
        }
        return observeRecordShow(ctx, live, 'drag', { from, to })
      },
    }),
    defineAbility({
      name: 'desktop_windows',
      description:
        'List the windows open on the desktop and which one is focused, with a fresh picture of the screen.',
      category: 'desktop',
      approval: 'continues',
      inputSchema: z.object({}),
      execute: async () => {
        const live = await getLiveDesk(ctx)
        if (!live.screenOpen) return NO_SCREEN
        const spent = await screenBudgetSpent(ctx, live)
        if (spent) return spent
        live.screenSteps += 1
        return observeRecordShow(ctx, live, 'screenshot', {})
      },
    }),
    defineAbility({
      name: 'desktop_focus',
      description:
        'Bring a window to the front by its id from desktop_windows. If the window manager refuses, click the window instead.',
      category: 'desktop',
      approval: 'continues',
      inputSchema: z.object({ windowId: z.string() }),
      execute: async ({ windowId }) => {
        const live = await getLiveDesk(ctx)
        if (!live.screenOpen) return NO_SCREEN
        const spent = await screenBudgetSpent(ctx, live)
        if (spent) return spent
        live.screenSteps += 1
        try {
          await runnerScreenPost(ctx, live, '/screen/focus', { windowId })
        } catch (error) {
          return {
            error: `The window could not be focused: ${describeError(error)}. Click it in the picture instead.`,
          }
        }
        return observeRecordShow(ctx, live, 'window_focus', { target: windowId })
      },
    }),
    defineAbility({
      name: 'desktop_open_app',
      description:
        'Launch an application on the desktop by its id — e.g. "chromium", "libreoffice", "thunar", "xfce4-terminal". You get a picture back once it is starting.',
      category: 'desktop',
      approval: 'continues',
      inputSchema: z.object({
        appId: z.string().describe('The application id, e.g. "libreoffice"'),
        args: z.array(z.string()).default([]).describe('Arguments, e.g. a file path to open'),
      }),
      execute: async ({ appId, args: appArgs }) => {
        const live = await getLiveDesk(ctx)
        if (!live.screenOpen) return NO_SCREEN
        const spent = await screenBudgetSpent(ctx, live)
        if (spent) return spent
        live.screenSteps += 1
        try {
          await runnerScreenPost(ctx, live, '/screen/launch', { appId, args: appArgs })
        } catch (error) {
          return { error: `The application could not be launched: ${describeError(error)}` }
        }
        return observeRecordShow(ctx, live, 'app_launch', { appId, args: appArgs })
      },
    }),
    defineAbility({
      name: 'request_takeover',
      description:
        'Hand your screen to a person — for the step you genuinely cannot do, like a login with a code on someone\'s phone. A human gets a link to watch or control your desktop for a bounded time; while they drive, NOTHING they type is recorded, only that a handover happened and for how long. Say exactly what you need them to do. Continue with other work while you wait, or end your turn.',
      category: 'desktop',
      inputSchema: z.object({
        reason: z.string().min(3).describe('What you need the person to do on the screen, precisely.'),
        scope: z.enum(['view', 'control']).default('control'),
        ttlMinutes: z.number().int().min(1).max(60).default(15),
      }),
      execute: async ({ reason, scope, ttlMinutes }) => {
        // Everything needed to reopen this handover rides the input, so an
        // approval replay (approval-executor.ts) — possibly minutes later, in
        // a different process — lands here and idempotently reopens the same
        // handover: the runner returns the active URL when one is live.
        const live = await ensureDesk(ctx)
        if (!live.screenOpen) {
          try {
            await runnerScreenPost(ctx, live, '/screen/start', {
              width: AGENT_SCREEN_WIDTH,
              height: AGENT_SCREEN_HEIGHT,
            })
            live.screenOpen = true
            live.screenSteps = 0
            await ctx.store.markScreenOpened({ tenantId, sessionId: live.sessionId, reason })
            await appendSerialized(ctx, live, 'screen_open', {
              width: AGENT_SCREEN_WIDTH,
              height: AGENT_SCREEN_HEIGHT,
              reason,
            })
          } catch (error) {
            return { granted: false, error: `The screen could not be started: ${describeError(error)}` }
          }
        }
        try {
          const runner = ctx.deps.runner ?? configuredDeskRunner()
          if (!runner) throw new Error('No desk runner is configured.')
          const { url } = await runnerPost<{ url: string }>(
            runner,
            ctx.deps,
            `/desks/${encodeURIComponent(live.deskId)}/handover`,
            { op: 'begin', ttlMs: ttlMinutes * 60_000, scope, actor: person.name },
          )
          await appendSerialized(ctx, live, 'handover_begin', { actor: person.name, scope, reason })
          return {
            granted: true,
            url,
            scope,
            expiresInMinutes: ttlMinutes,
            note: 'Share what you need done. While a person drives, nothing they type reaches your context or the record.',
          }
        } catch (error) {
          return { granted: false, error: `The handover could not be opened: ${describeError(error)}` }
        }
      },
    }),
  )

  return abilities
}
