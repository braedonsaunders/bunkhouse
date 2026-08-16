import 'server-only'
import { mkdir, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { runSandbox } from '@appkit/sandbox'
import { defineAbility, type Ability } from '@bunkhouse/runtime'
import {
  backgroundJobs,
  deskEvents,
  deskSessions,
  people,
  shellSessions,
  tenantSettings,
  WORKSPACE_POLICY_KEY,
  type WorkspacePolicySettings,
} from '../db/schema'
import { db } from '../db/client'
import { deskRuntimeStatus, resolveShellExecutionPolicy, type DeskRuntimeStatus } from './desk'
import { deskEventPresentation } from './call-activity'
import type { RunDeskEventRow } from '../components/run-tables'

/**
 * The workspace policy and the cheapest execution tier.
 *
 * The agent's actual filesystem moved into its desk (lib/desk.ts): the guest
 * home IS the workspace now, and `run_shell` plus the workspace file abilities
 * live there, over the desk-runner. What stays here is what never needed a
 * machine at all: `run_script` (QuickJS, in-process — tier 0, pure
 * computation), the tenant's workspace policy, and housekeeping for the legacy
 * homes root, which remains only as the skill-bundle staging area and as
 * history for pre-desk deployments.
 */

function homesRoot(): string {
  return resolve(/* turbopackIgnore: true */ process.env.BUNKHOUSE_AGENT_HOMES ?? '/data/agent-homes')
}

export async function agentHomePath(tenantId: string, personId: string): Promise<string> {
  const home = join(/* turbopackIgnore: true */ homesRoot(), tenantId, personId)
  await mkdir(/* turbopackIgnore: true */ home, { recursive: true })
  return home
}

/** Resolve a path inside the home, refusing anything that escapes it. */
function insideHome(home: string, relativePath: string): string {
  const target = resolve(/* turbopackIgnore: true */ home, relativePath)
  if (target !== home && !target.startsWith(home + sep)) {
    throw new Error('Path escapes the workspace.')
  }
  return target
}

/** Is this path inside that root, on a separator boundary? */
export function insideRoot(root: string, candidate: string): boolean {
  const base = resolve(root)
  const target = resolve(candidate)
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)
}

/** Where a loaded skill's bundle lands inside the agent's home. */
export const SKILLS_FOLDER = 'skills'

/**
 * Write one skill's files into the agent's staging home so its instructions
 * can refer to them. Rewritten from the database on every load, so a file an
 * agent altered on a previous run never becomes what the skill "is".
 *
 * NOTE: with the desk cutover this writes to the web tier's homes root, not
 * the guest disk — syncing bundles into the guest home is a follow-up on the
 * desk workstream. A skill with scripts is inert until that lands.
 */
export async function materializeSkillBundle(args: {
  tenantId: string
  personId: string
  slug: string
  files: { path: string; bytes: Uint8Array }[]
}): Promise<{ path: string; files: string[] }> {
  const home = await agentHomePath(args.tenantId, args.personId)
  const root = insideHome(home, join(/* turbopackIgnore: true */ SKILLS_FOLDER, args.slug))
  await rm(/* turbopackIgnore: true */ root, { recursive: true, force: true })
  await mkdir(/* turbopackIgnore: true */ root, { recursive: true })

  const written: string[] = []
  for (const file of args.files) {
    // Belt and braces: install already refuses unsafe paths, but this is the
    // moment one would actually escape, so it is checked again here.
    const target = insideHome(root, file.path)
    await mkdir(/* turbopackIgnore: true */ dirname(target), { recursive: true })
    await writeFile(/* turbopackIgnore: true */ target, file.bytes)
    written.push(file.path)
  }
  return { path: `~/${SKILLS_FOLDER}/${args.slug}`, files: written }
}

export async function getWorkspacePolicy(tenantId: string): Promise<WorkspacePolicySettings> {
  const app = db()
  const [row] = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ value: tenantSettings.value })
      .from(tenantSettings)
      .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, WORKSPACE_POLICY_KEY))),
  )
  const stored = row?.value as Partial<WorkspacePolicySettings> | undefined
  return {
    retentionDays: typeof stored?.retentionDays === 'number' ? stored.retentionDays : null,
    shell: resolveShellExecutionPolicy(stored?.shell),
  }
}

export async function saveWorkspacePolicy(tenantId: string, value: WorkspacePolicySettings): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .insert(tenantSettings)
      .values({ tenantId, key: WORKSPACE_POLICY_KEY, value })
      .onConflictDoUpdate({
        target: [tenantSettings.tenantId, tenantSettings.key],
        set: { value, updatedAt: new Date() },
      })
  })
}

export type ShellSessionView = {
  id: string
  executionId: string | null
  personName: string
  command: string
  cwd: string
  status: 'completed' | 'failed' | 'timeout'
  exitCode: number | null
  output: string
  outputTruncated: boolean
  durationMs: number
  startedAt: string
  finishedAt: string | null
}

/**
 * The operator's workspace surface: desk-runner health plus recent shell
 * history. New commands land on the desk ledger (desk_events); the
 * shell_sessions rows shown here are the audit history of the pre-desk
 * surface and stop growing. The observatory's desk replay supersedes this
 * view when the UI workstream lands.
 */
export async function workspaceRuntimeView(tenantId: string): Promise<{
  runtime: DeskRuntimeStatus
  sessions: ShellSessionView[]
}> {
  const app = db()
  const [runtime, sessions] = await Promise.all([
    deskRuntimeStatus(),
    app.withTenantContext(tenantId, () =>
      app.db
        .select({
          id: shellSessions.id,
          executionId: shellSessions.executionId,
          personName: people.name,
          command: shellSessions.command,
          cwd: shellSessions.cwd,
          status: shellSessions.status,
          exitCode: shellSessions.exitCode,
          output: shellSessions.output,
          outputTruncated: shellSessions.outputTruncated,
          durationMs: shellSessions.durationMs,
          startedAt: shellSessions.startedAt,
          finishedAt: shellSessions.finishedAt,
        })
        .from(shellSessions)
        .innerJoin(people, eq(people.id, shellSessions.personId))
        .orderBy(desc(shellSessions.startedAt))
        .limit(25),
    ),
  ])
  return {
    runtime,
    sessions: sessions.map((session) => ({
      ...session,
      startedAt: session.startedAt.toISOString(),
      finishedAt: session.finishedAt?.toISOString() ?? null,
    })),
  }
}

export type DeskSessionRowView = {
  id: string
  personName: string
  runId: string
  status: 'active' | 'ended' | 'failed'
  screenReason: string | null
  startedAt: string
  endedAt: string | null
  eventCount: number
  /** The interleaved replay, oldest first, capped for transport. */
  events: RunDeskEventRow[]
  eventsTruncated: boolean
}

export type DeskJobRowView = {
  id: string
  personName: string
  command: string
  status: 'running' | 'exited' | 'killed'
  startedAt: string
  exitedAt: string | null
  exitCode: number | null
}

export type DeskEscalationRowView = {
  sessionId: string
  personName: string
  /** The agent's stated justification for opening a screen — §3.17. */
  reason: string
  at: string
  /** Screen steps this session spent, against the tenant's per-session ceiling. */
  stepsUsed: number
  stepCeiling: number
}

export type DeskOperationsData = {
  sessions: DeskSessionRowView[]
  jobs: DeskJobRowView[]
  escalations: DeskEscalationRowView[]
}

/** How many recent sessions the operator surface replays. */
const DESK_SESSION_LIMIT = 12
/** Events shipped per session drawer; the run record shows the full stream. */
const DESK_SESSION_EVENT_CAP = 200

/** The kinds that spend the §3.18 screen budget once a screen is open. */
const SCREEN_STEP_KINDS: ReadonlySet<string> = new Set([
  'screenshot',
  'click',
  'type',
  'key',
  'scroll',
  'drag',
  'window_focus',
  'app_launch',
])

/**
 * The operator's desk surface: recent sessions with their interleaved replay,
 * the background jobs table (a running process nobody can see is the failure
 * mode there), and the escalation record — every screen opened, with the
 * stated reason and what the session spent against its step ceiling. A pattern
 * of opening a screen when a connector existed is something an operator can
 * see here and correct (§3.17).
 */
export async function deskOperationsView(
  tenantId: string,
  stepCeiling: number,
): Promise<DeskOperationsData> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const sessions = await app.db
      .select({
        id: deskSessions.id,
        personName: people.name,
        runId: deskSessions.runId,
        status: deskSessions.status,
        screenReason: deskSessions.screenReason,
        screenOpenedAt: deskSessions.screenOpenedAt,
        startedAt: deskSessions.startedAt,
        endedAt: deskSessions.endedAt,
      })
      .from(deskSessions)
      .innerJoin(people, eq(people.id, deskSessions.personId))
      .orderBy(desc(deskSessions.startedAt))
      .limit(DESK_SESSION_LIMIT)

    const sessionIds = sessions.map((session) => session.id)
    const events = sessionIds.length
      ? await app.db
          .select({
            sessionId: deskEvents.sessionId,
            seq: deskEvents.seq,
            kind: deskEvents.kind,
            detail: deskEvents.detail,
            screenshotFileId: deskEvents.screenshotFileId,
            at: deskEvents.at,
          })
          .from(deskEvents)
          .where(inArray(deskEvents.sessionId, sessionIds))
          .orderBy(asc(deskEvents.sessionId), asc(deskEvents.seq))
      : []
    const bySession = new Map<string, typeof events>()
    for (const event of events) {
      const list = bySession.get(event.sessionId) ?? []
      list.push(event)
      bySession.set(event.sessionId, list)
    }

    const jobs = await app.db
      .select({
        id: backgroundJobs.id,
        personName: people.name,
        command: backgroundJobs.command,
        status: backgroundJobs.status,
        startedAt: backgroundJobs.startedAt,
        exitedAt: backgroundJobs.exitedAt,
        exitCode: backgroundJobs.exitCode,
      })
      .from(backgroundJobs)
      .innerJoin(people, eq(people.id, backgroundJobs.personId))
      .orderBy(desc(backgroundJobs.startedAt))
      .limit(50)

    const escalations: DeskEscalationRowView[] = []
    for (const session of sessions) {
      if (!session.screenReason || !session.screenOpenedAt) continue
      const opened = session.screenOpenedAt.getTime()
      const stepsUsed = (bySession.get(session.id) ?? []).filter(
        (event) => SCREEN_STEP_KINDS.has(event.kind) && event.at.getTime() >= opened,
      ).length
      escalations.push({
        sessionId: session.id,
        personName: session.personName,
        reason: session.screenReason,
        at: session.screenOpenedAt.toISOString(),
        stepsUsed,
        stepCeiling,
      })
    }

    return {
      sessions: sessions.map((session) => {
        const all = bySession.get(session.id) ?? []
        return {
          id: session.id,
          personName: session.personName,
          runId: session.runId,
          status: session.status,
          screenReason: session.screenReason,
          startedAt: session.startedAt.toISOString(),
          endedAt: session.endedAt?.toISOString() ?? null,
          eventCount: all.length,
          events: all.slice(0, DESK_SESSION_EVENT_CAP).map((event) => ({
            seq: event.seq,
            kind: event.kind,
            ...deskEventPresentation(event.kind, event.detail),
            screenshotFileId: event.screenshotFileId,
          })),
          eventsTruncated: all.length > DESK_SESSION_EVENT_CAP,
        }
      }),
      // Running first: the list exists so a daemon is never invisible.
      jobs: [...jobs]
        .sort((a, b) =>
          a.status === b.status ? 0 : a.status === 'running' ? -1 : b.status === 'running' ? 1 : 0,
        )
        .map((job) => ({
          id: job.id,
          personName: job.personName,
          command: job.command,
          status: job.status,
          startedAt: job.startedAt.toISOString(),
          exitedAt: job.exitedAt?.toISOString() ?? null,
          exitCode: job.exitCode,
        })),
      escalations,
    }
  })
}

/**
 * Housekeeping: apply the tenant's retention policy to the staging homes root.
 * Deletes only files whose last modification is older than the configured
 * window, then prunes directories left empty. With retention off (the
 * default), this touches nothing. Idempotent — safe on every tick.
 */
export async function tidyWorkspaces(tenantId: string): Promise<{ deleted: number }> {
  const policy = await getWorkspacePolicy(tenantId)
  if (!policy.retentionDays || policy.retentionDays < 1) return { deleted: 0 }
  const cutoff = Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000
  const tenantRoot = join(/* turbopackIgnore: true */ homesRoot(), tenantId)
  let deleted = 0

  const sweep = async (dir: string, isRoot: boolean): Promise<void> => {
    const names = await readdir(/* turbopackIgnore: true */ dir).catch(() => null)
    if (names === null) return
    for (const name of names) {
      const full = join(/* turbopackIgnore: true */ dir, name)
      const info = await stat(/* turbopackIgnore: true */ full).catch(() => null)
      if (!info) continue
      if (info.isDirectory()) {
        await sweep(full, false)
      } else if (info.mtime.getTime() < cutoff) {
        await rm(/* turbopackIgnore: true */ full, { force: true }).catch(() => {})
        deleted += 1
      }
    }
    if (!isRoot) {
      const remaining = await readdir(/* turbopackIgnore: true */ dir).catch(() => null)
      if (remaining !== null && remaining.length === 0)
        await rmdir(/* turbopackIgnore: true */ dir).catch(() => {})
    }
  }

  // Agent home directories themselves are kept; only their contents age out.
  const homes = await readdir(/* turbopackIgnore: true */ tenantRoot).catch(() => [])
  for (const personId of homes) {
    const home = join(/* turbopackIgnore: true */ tenantRoot, personId)
    const info = await stat(/* turbopackIgnore: true */ home).catch(() => null)
    if (info?.isDirectory()) await sweep(home, true)
  }
  return { deleted }
}

/**
 * The one workspace ability that never needed a machine: pure computation in
 * QuickJS, in-process. Unchanged by the desk cutover on purpose — it is the
 * cheapest tier and the right answer for math a model should not estimate.
 */
export function workspaceAbilities(): Ability[] {
  return [
    defineAbility({
      name: 'run_script',
      description:
        'Run a short JavaScript computation in a secure sandbox — for math, data transformation, aggregation, date arithmetic: anything you should calculate rather than estimate. The source must declare `function main(input)`; its return value (JSON-serializable) comes back to you. No network, filesystem, or imports — pure computation on the input you pass.',
      category: null,
      inputSchema: z.object({
        source: z.string().describe('JavaScript declaring function main(input) { ... return value }'),
        input: z.unknown().describe('The JSON value passed to main()'),
      }),
      execute: async ({ source, input }) => {
        // Models pass `input` as a JSON-encoded STRING often enough to matter:
        // one call burned four attempts and two and a half minutes on
        // `main(input)` reading properties off a string, each failure saying
        // only "cannot read property of undefined". A string that parses as
        // JSON was meant as the value it encodes; a string that does not is a
        // genuine string input and goes through untouched.
        let value = input ?? null
        if (typeof value === 'string') {
          try {
            value = JSON.parse(value)
          } catch {
            // Not JSON — an intentional string input.
          }
        }
        const result = await runSandbox({ source, input: value, timeoutMs: 5000 })
        return result.status === 'ok'
          ? { status: 'ok', value: result.value, logs: result.logs }
          : { status: result.status, error: result.error ?? 'The script did not complete.', logs: result.logs }
      },
    }),
  ]
}
