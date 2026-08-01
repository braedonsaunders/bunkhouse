import 'server-only'
import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { runSandbox } from '@appkit/sandbox'
import { isProcessSandboxSupported } from '@appkit/process-sandbox'
import { defineAbility, type Ability } from '@bunkhouse/runtime'
import {
  people,
  shellSessions,
  tenantSettings,
  WORKSPACE_POLICY_KEY,
  type WorkspacePolicySettings,
} from '../db/schema'
import { db } from '../db/client'
import { configuredRunner, runSandboxedShell, runShellRemotely } from './shell-sandbox'
import { saveFile } from './files'

/**
 * The workspace: each agent's persistent home directory — its desk. Files
 * written there survive across runs and calls, like a human's working folder;
 * shell commands run inside a bubblewrap sandbox with ONLY that home writable,
 * and every command lands in the append-only shell_sessions ledger.
 *
 * The homes root is deployment infrastructure (a mounted volume shared by the
 * web, worker, and voice services); which files exist is the agent's business,
 * surfaced through its own tools and the files ledger when work is published.
 */

type PersonRow = typeof people.$inferSelect

const READ_CAP_BYTES = 32 * 1024
const LIST_CAP = 200

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

/**
 * Whether this deployment can run a shell command at all.
 *
 * The local probe alone was the wrong question the moment the sandbox moved to
 * its own container: `web` and `worker` cannot build a bubblewrap sandbox and
 * are not meant to, so asking them would withdraw `run_shell` from every agent
 * precisely when it had started working. A configured runner IS the support.
 */
export function shellSupported(): boolean {
  return configuredRunner() !== null || isProcessSandboxSupported()
}

/** Where a loaded skill's bundle lands inside the agent's home. */
export const SKILLS_FOLDER = 'skills'

/**
 * Write one skill's files into the agent's workspace so its own instructions
 * can refer to them — and so any script it ships is reachable by the sandboxed
 * shell the agent already has. Nothing new is granted here: `run_shell` is
 * still the only way anything executes, still bubblewrapped with the home as
 * the sole writable path, still governed by the shell dial, and still recorded.
 * A skill with scripts is inert on a deployment where the shell is unavailable.
 *
 * Rewritten from the database on every load, so a file an agent altered on a
 * previous run never becomes what the skill "is" — the installed bytes are the
 * only truth, and this folder is a cache of them.
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
  return (row?.value as WorkspacePolicySettings | undefined) ?? { retentionDays: null }
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

/**
 * Housekeeping: apply the tenant's retention policy to its agents' workspaces.
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

async function runShell(args: {
  tenantId: string
  person: PersonRow
  runId: string
  command: string
  cwd: string
}): Promise<{ status: 'completed' | 'failed' | 'timeout'; exitCode: number | null; output: string }> {
  const home = await agentHomePath(args.tenantId, args.person.id)
  const cwd = insideHome(home, args.cwd)
  const startedAt = new Date()

  // Where this actually runs is a deployment question, not an agent-facing one
  // — see shell-sandbox.ts. With a runner configured the command goes to the
  // one container that has the privileges bubblewrap needs; without one it
  // runs here, which is what a developer machine does. The record below is
  // written the same way either way, so the ledger does not know or care.
  const runner = configuredRunner()
  const result = runner
    ? await runShellRemotely(runner, { home, cwd, command: args.command })
    : await runSandboxedShell({ home, cwd, command: args.command })

  const app = db()
  await app.withTenant(args.tenantId, async () => {
    await app.db.insert(shellSessions).values({
      tenantId: args.tenantId,
      personId: args.person.id,
      runId: args.runId,
      command: args.command,
      cwd: args.cwd,
      status: result.status,
      exitCode: result.exitCode,
      output: result.output,
      durationMs: Date.now() - startedAt.getTime(),
      startedAt,
    })
  })

  return result
}

export function workspaceAbilities(args: { tenantId: string; person: PersonRow; runId: string }): Ability[] {
  const { tenantId, person, runId } = args

  const abilities: Ability[] = [
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
        const result = await runSandbox({ source, input: input ?? null, timeoutMs: 5000 })
        return result.status === 'ok'
          ? { status: 'ok', value: result.value, logs: result.logs }
          : { status: result.status, error: result.error ?? 'The script did not complete.', logs: result.logs }
      },
    }),
    defineAbility({
      name: 'list_workspace_files',
      description:
        'List the files in your workspace — your persistent home folder. Work you saved there in earlier runs and calls is still there.',
      category: null,
      inputSchema: z.object({
        path: z.string().default('.').describe('Folder inside your workspace, e.g. "." or "projects"'),
      }),
      execute: async ({ path }) => {
        const home = await agentHomePath(tenantId, person.id)
        const dir = insideHome(home, path)
        const entries: { path: string; kind: 'file' | 'folder'; sizeBytes?: number; modifiedAt?: string }[] = []
        const walk = async (current: string, prefix: string, depth: number): Promise<void> => {
          if (depth > 4 || entries.length >= LIST_CAP) return
          const names = await readdir(/* turbopackIgnore: true */ current).catch(() => [])
          for (const name of names) {
            if (entries.length >= LIST_CAP) return
            const full = join(/* turbopackIgnore: true */ current, name)
            const info = await stat(/* turbopackIgnore: true */ full).catch(() => null)
            if (!info) continue
            const rel = prefix ? `${prefix}/${name}` : name
            if (info.isDirectory()) {
              entries.push({ path: rel, kind: 'folder' })
              await walk(full, rel, depth + 1)
            } else {
              entries.push({ path: rel, kind: 'file', sizeBytes: info.size, modifiedAt: info.mtime.toISOString() })
            }
          }
        }
        await walk(dir, '', 0)
        return { entries, ...(entries.length >= LIST_CAP ? { note: `Listing capped at ${LIST_CAP} entries.` } : {}) }
      },
    }),
    defineAbility({
      name: 'read_workspace_file',
      description: 'Read a text file from your workspace (truncated past 32 KB).',
      category: null,
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const home = await agentHomePath(tenantId, person.id)
        const target = insideHome(home, path)
        const info = await stat(/* turbopackIgnore: true */ target).catch(() => null)
        if (!info || !info.isFile()) return { found: false, reason: 'No such file in your workspace.' }
        const bytes = await readFile(/* turbopackIgnore: true */ target)
        const text = bytes.subarray(0, READ_CAP_BYTES).toString('utf8')
        return { found: true, text, ...(bytes.length > READ_CAP_BYTES ? { truncated: true } : {}) }
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
        const home = await agentHomePath(tenantId, person.id)
        const target = insideHome(home, path)
        const info = await stat(/* turbopackIgnore: true */ target).catch(() => null)
        if (!info || !info.isFile()) return { published: false, reason: 'No such file in your workspace.' }
        const bytes = await readFile(/* turbopackIgnore: true */ target)
        const record = await saveFile({
          tenantId,
          personId: person.id,
          runId,
          kind: 'document',
          filename: filename ?? path.split('/').pop() ?? 'file',
          contentType: contentType ?? 'application/octet-stream',
          bytes,
        })
        return { published: true, fileId: record.id, filename: record.filename, sizeBytes: record.sizeBytes }
      },
    }),
  ]

  if (shellSupported()) {
    abilities.push(
      defineAbility({
        name: 'run_shell',
        description:
          'Run a shell command in your sandboxed workspace. Your home folder is the only writable place and it persists — files you create are there next time. 120-second limit per command; output is captured on the record. Use it for real work: organizing files, processing data, preparing material you then publish and send.',
        category: 'shell',
        inputSchema: z.object({
          command: z.string().describe('The command line, run with /bin/sh -lc'),
          cwd: z.string().default('.').describe('Working folder inside your workspace'),
        }),
        execute: async ({ command, cwd }) => runShell({ tenantId, person, runId, command, cwd }),
      }),
    )
  }

  return abilities
}
