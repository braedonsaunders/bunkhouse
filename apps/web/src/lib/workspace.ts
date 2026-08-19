import 'server-only'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { runSandbox } from '@braedonsaunders/appkit-sandbox'
import { defineAbility, type Ability } from '@bunkhouse/runtime'
import {
  backgroundJobs,
  deskEvents,
  deskSessions,
  people,
  tenantSettings,
  WORKSPACE_POLICY_KEY,
  type WorkspacePolicySettings,
} from '../db/schema'
import { db } from '../db/client'
import {
  deskRuntimeStatus,
  configuredDeskRunner,
  ensurePersonDesk,
  execOnDesk,
  guestWorkspacePath,
  recordDeskLedgerEvent,
  resolveShellExecutionPolicy,
  type DeskRuntimeStatus,
} from './desk'
import { deskEventPresentation } from './call-activity'
import { resolveDeskFeatures } from './desk-policy'
import type { RunDeskEventRow } from '../components/run-tables'

/**
 * The workspace policy and the cheapest execution tier.
 *
 * The agent's actual filesystem moved into its desk (lib/desk.ts): the guest
 * home IS the workspace now, and `run_shell` plus the workspace file abilities
 * live there, over the desk-runner. What stays here is what never needed a
 * machine at all: `run_script` (QuickJS, in-process — tier 0, pure
 * computation), the tenant's workspace policy, and housekeeping for the
 * canonical homes inside employee microVMs.
 */

/** Where a loaded skill's bundle lands inside the agent's home. */
export const SKILLS_FOLDER = 'skills'

/**
 * Write one skill's files into the agent's canonical microVM home so its instructions
 * can refer to them. Rewritten from the database on every load, so a file an
 * agent altered on a previous run never becomes what the skill "is".
 *
 * The desk cutover makes this the guest disk itself. Skills and chat inputs
 * therefore share the same persistent `/home/agent` that shell and desktop
 * work use; there is no second web-tier workspace to drift out of sync.
 */
export async function materializeSkillBundle(args: {
  tenantId: string
  personId: string
  runId: string
  slug: string
  files: { path: string; bytes: Uint8Array; isScript: boolean }[]
}): Promise<{ path: string; files: string[] }> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(args.slug)) throw new Error('Skill slug is not safe to materialize.')
  const features = await resolveDeskFeatures(args.tenantId)
  if (!features.desk) throw new Error('Skill files require the employee machine, which is disabled for this company.')
  const relativeRoot = `.bunkhouse/runs/${args.runId}/${SKILLS_FOLDER}/${args.slug}`
  const root = guestWorkspacePath(relativeRoot)
  const { deskId } = await ensurePersonDesk({ tenantId: args.tenantId, personId: args.personId })
  const execute = async (command: readonly string[], timeoutMs = 30_000): Promise<void> => {
    const outcome = await execOnDesk({ deskId, command, cwd: '/home/agent', timeoutMs, outputLimitKb: 64 })
    if (outcome.status !== 'completed') {
      throw new Error(outcome.output.trim() || `The employee machine could not stage the skill (${outcome.status}).`)
    }
  }
  const written: string[] = []
  try {
    await execute(['/bin/rm', '-rf', '--', root])
    await execute(['/usr/bin/install', '-d', '-m', '0700', root])
    for (const file of args.files) {
      const target = guestWorkspacePath(`${relativeRoot}/${file.path}`)
      const parent = target.slice(0, target.lastIndexOf('/'))
      await execute(['/usr/bin/install', '-d', '-m', '0700', parent])
      await execute(['/usr/bin/install', '-m', file.isScript ? '0700' : '0600', '/dev/null', target])
      // The Desk request body is bounded. Chunking keeps even the maximum
      // 2 MB skill member well below that bound without inventing a second
      // upload service beside the microVM.
      for (let offset = 0; offset < file.bytes.byteLength; offset += 128 * 1024) {
        const encoded = Buffer.from(file.bytes.slice(offset, offset + 128 * 1024)).toString('base64')
        await execute([
          '/usr/bin/node',
          '-e',
          "require('node:fs').appendFileSync(process.argv[1],Buffer.from(process.argv[2],'base64'))",
          target,
          encoded,
        ])
      }
      written.push(file.path)
      await recordDeskLedgerEvent({
        tenantId: args.tenantId,
        personId: args.personId,
        runId: args.runId,
        kind: 'file_write',
        detail: { target: target.replace('/home/agent/', '~/'), title: `Loaded skill ${args.slug}` },
      })
    }
  } catch (error) {
    await execOnDesk({ deskId, command: ['/bin/rm', '-rf', '--', root], cwd: '/home/agent', timeoutMs: 30_000, outputLimitKb: 16 }).catch(() => undefined)
    throw error
  }
  return { path: `~/${relativeRoot}`, files: written }
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
 * history projected directly from the one append-only Desk ledger.
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
          id: deskEvents.id,
          personName: people.name,
          detail: deskEvents.detail,
          at: deskEvents.at,
        })
        .from(deskEvents)
        .innerJoin(deskSessions, eq(deskSessions.id, deskEvents.sessionId))
        .innerJoin(people, eq(people.id, deskSessions.personId))
        .where(eq(deskEvents.kind, 'shell_command'))
        .orderBy(desc(deskEvents.at))
        .limit(25),
    ),
  ])
  return {
    runtime,
    sessions: sessions.map((session) => {
      const startedAt = session.detail.startedAt ?? session.at.toISOString()
      const finishedAt = session.detail.finishedAt ?? session.at.toISOString()
      return {
        id: session.id,
        executionId: null,
        personName: session.personName,
        command: session.detail.command ?? '',
        cwd: session.detail.cwd ?? '.',
        status: session.detail.commandStatus ?? (session.detail.exitCode === 0 ? 'completed' : 'failed'),
        exitCode: session.detail.exitCode ?? null,
        output: session.detail.output ?? '',
        outputTruncated: session.detail.outputTruncated ?? false,
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
        startedAt,
        finishedAt,
      }
    }),
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
 * Housekeeping for the real workspace: each employee's /home/agent inside its
 * persistent microVM. Runtime-owned browser/desktop profiles are excluded;
 * ordinary files and loaded skill bundles follow the tenant's retention
 * window. With retention off (the default), this touches nothing.
 */
export async function tidyWorkspaces(tenantId: string): Promise<{ deleted: number }> {
  const policy = await getWorkspacePolicy(tenantId)
  if (!policy.retentionDays || policy.retentionDays < 1) return { deleted: 0 }
  if (!configuredDeskRunner()) return { deleted: 0 }
  const app = db()
  const agents = await app.withTenantContext(tenantId, () =>
    app.db.select({ id: people.id }).from(people).where(eq(people.kind, 'agent')),
  )
  let deleted = 0
  const sweepSource = String.raw`
const fs=require('node:fs');const path=require('node:path');
const root='/home/agent',cutoff=Date.now()-Number(process.argv[1])*86400000;
const protectedTop=new Set(['.cache','.config','.local']);let deleted=0;
function sweep(dir,isRoot){for(const name of fs.readdirSync(dir)){if(isRoot&&protectedTop.has(name))continue;const full=path.join(dir,name);let info;try{info=fs.lstatSync(full)}catch{continue}if(info.isDirectory()&&!info.isSymbolicLink()){sweep(full,false);try{if(fs.readdirSync(full).length===0)fs.rmdirSync(full)}catch{}}else if(info.mtimeMs<cutoff){try{fs.unlinkSync(full);deleted++}catch{}}}}
sweep(root,true);process.stdout.write(String(deleted));`
  for (const agent of agents) {
    try {
      const { deskId } = await ensurePersonDesk({ tenantId, personId: agent.id })
      const outcome = await execOnDesk({
        deskId,
        command: ['/usr/bin/node', '-e', sweepSource, String(policy.retentionDays)],
        cwd: '/home/agent',
        timeoutMs: 120_000,
        outputLimitKb: 16,
      })
      if (outcome.status === 'completed') deleted += Number.parseInt(outcome.output.trim(), 10) || 0
    } catch {
      // One stopped or unhealthy employee machine must not block every other
      // employee's retention pass; the next worker tick retries it.
    }
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
