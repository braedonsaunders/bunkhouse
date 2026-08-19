import 'server-only'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  DEFAULT_AGENT_TOOL_POLICY,
  agentToolCommands,
  createAgentToolRuntime,
  createProcessSandboxRunner,
  type AgentToolManifest,
  type AgentToolRuntime,
} from '@braedonsaunders/appkit-agent-tools'
import { createDrizzleAgentToolStore } from '@braedonsaunders/appkit-agent-tools/drizzle'
import { defineAbility, type Ability } from '@bunkhouse/runtime'
import { people, tenantSettings, TOOL_POLICY_KEY, type ToolPolicySettings } from '../db/schema'
import { db } from '../db/client'
import { GUEST_HOME, configuredDeskRunner, deskIdFor, deskSupported, execOnDesk, recordDeskLedgerEvent } from './desk'
import { TOOL_CATALOGUE } from './tool-catalogue'

export { TOOL_CATALOGUE }

/**
 * The tool shelf: command-line programs an agent may run, pinned to exact
 * versions with a declared risk and a health an operator can see.
 *
 * The desk cutover changed WHERE these run
 * and WHAT the shelf enforces. Tools execute on the agent's desk — the
 * catalogue is baked into the golden base image (lib/base-image.ts), so a run
 * is just the pinned binary in the guest. The package's install/execute
 * approval gates no longer sit on the agent path: an agent with a terminal
 * walks around a per-command gate in one line, so keeping it would be false
 * assurance. What the shelf keeps is everything that never depended on the
 * gate — the pinning, the health checks, revocability (`enabled`), and the
 * operator-visible listing. Real enforcement is the `sandbox` dial (which
 * gates having a machine at all), the egress proxy, and the desk ledger,
 * where every tool run lands as a shell_command event.
 */

type PersonRow = typeof people.$inferSelect

/** Where npm-installed tools land on NON-desk consumers of the runtime. */
function toolsRoot(): string {
  return resolve(/* turbopackIgnore: true */ process.env.BUNKHOUSE_AGENT_TOOLS ?? '/data/agent-tools')
}

/** Tools run on the desk; no desk, no tools — fail closed like run_shell. */
export function toolsSupported(): boolean {
  return deskSupported()
}

export async function getToolPolicy(tenantId: string): Promise<ToolPolicySettings> {
  const app = db()
  const [row] = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ value: tenantSettings.value })
      .from(tenantSettings)
      .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, TOOL_POLICY_KEY))),
  )
  return (row?.value as ToolPolicySettings | undefined) ?? DEFAULT_AGENT_TOOL_POLICY
}

export async function saveToolPolicy(tenantId: string, value: ToolPolicySettings): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .insert(tenantSettings)
      .values({ tenantId, key: TOOL_POLICY_KEY, value })
      .onConflictDoUpdate({
        target: [tenantSettings.tenantId, tenantSettings.key],
        set: { value, updatedAt: new Date() },
      })
  })
}

/**
 * The runtime, bound to one tenant — the shelf's bookkeeping (register, list,
 * health, revocation), not the agent execution path.
 */
export function toolRuntime(tenantId: string): AgentToolRuntime {
  const app = db()
  return createAgentToolRuntime({
    store: createDrizzleAgentToolStore(app.db),
    runner: createProcessSandboxRunner(),
    installRoot: toolsRoot(),
    policy: () => getToolPolicy(tenantId),
  })
}

/** Put every catalogued tool on this tenant's shelf. Idempotent. */
export async function syncToolCatalogue(tenantId: string): Promise<{ registered: number }> {
  const app = db()
  const runtime = toolRuntime(tenantId)
  await app.withTenant(tenantId, async () => {
    for (const manifest of TOOL_CATALOGUE) {
      await runtime.register(tenantId, manifest, 'system')
    }
  })
  return { registered: TOOL_CATALOGUE.length }
}

/**
 * Housekeeping on the shelf: let unanswered requests and spent grants lapse,
 * then re-check that installed tools still work. A tool that has gone bad is
 * worth knowing about before an agent reaches for it mid-errand.
 */
export async function toolHousekeeping(
  tenantId: string,
): Promise<{ expired: number; checked: number; degraded: number }> {
  const app = db()
  const runtime = toolRuntime(tenantId)
  return app.withTenant(tenantId, async () => {
    const expired = await runtime.expireStale(tenantId)
    let checked = 0
    let degraded = 0
    for (const tool of await runtime.list(tenantId)) {
      if (tool.status !== 'installed') continue
      checked += 1
      const health = await runtime.checkHealth(tenantId, tool.toolId)
      if (health.outcome === 'ok' && health.tool.health !== 'healthy') degraded += 1
    }
    return { expired, checked, degraded }
  })
}

/**
 * What an agent should be told about its shelf: enough to choose a tool, not so
 * much that six of them crowd the context window.
 */
async function describeShelf(tenantId: string): Promise<string> {
  const app = db()
  const tools = await app.withTenantContext(tenantId, () => toolRuntime(tenantId).list(tenantId))
  if (tools.length === 0) return 'Your shelf is empty.'
  return tools
    .filter((tool) => tool.enabled)
    .map(
      (tool) =>
        `${tool.toolId} — ${tool.manifest.description} Commands: ${tool.manifest.bins
          .map((bin) => bin.name)
          .join(', ')}.`,
    )
    .join('\n')
}

/**
 * Which enabled shelf entry offers this command, and the executable it maps
 * to. Prefers the tenant's shelf (revocation applies); falls back to the
 * static catalogue so a shelf that has not been synced does not brick tools.
 */
async function resolveShelfCommand(
  tenantId: string,
  toolId: string,
  command: string,
): Promise<{ manifest: AgentToolManifest; bin: string } | { error: string }> {
  const app = db()
  const shelf = await app.withTenantContext(tenantId, () => toolRuntime(tenantId).list(tenantId))
  const record = shelf.find((tool) => tool.toolId === toolId)
  if (record && !record.enabled) return { error: `The ${toolId} tool has been disabled by an operator.` }
  const manifest = record?.manifest ?? TOOL_CATALOGUE.find((tool) => tool.id === toolId)
  if (!manifest) return { error: `No tool named "${toolId}" is on your shelf — use list_tools.` }
  if (!agentToolCommands(manifest).includes(command)) {
    return { error: `${toolId} does not offer a "${command}" command. It offers: ${agentToolCommands(manifest).join(', ')}.` }
  }
  const bin = manifest.bins.find((entry) => entry.name === command)
  if (!bin) return { error: `${toolId} does not offer a "${command}" command.` }
  return { manifest, bin: bin.bin }
}

export function toolAbilities(args: { tenantId: string; person: PersonRow; runId: string }): Ability[] {
  const { tenantId, person, runId } = args
  if (!toolsSupported()) return []

  return [
    defineAbility({
      name: 'list_tools',
      description:
        'List the command-line tools on your shelf — what each one does and the commands it offers. They are pre-installed on your machine.',
      category: null,
      inputSchema: z.object({}),
      execute: async () => ({ shelf: await describeShelf(tenantId) }),
    }),
    defineAbility({
      name: 'run_tool',
      description:
        'Run one of the tools on your shelf against files in your workspace. Give the tool id, the command name, and its arguments as a list (there is no shell, so no pipes, quotes, or redirection — write output with the tool\'s own flag). Your home folder is the working directory. The run is recorded on your desk ledger like any command.',
      category: 'sandbox',
      inputSchema: z.object({
        tool: z.string().describe('The tool id from list_tools, e.g. "prettier"'),
        command: z.string().describe('The command that tool offers, e.g. "prettier"'),
        args: z
          .array(z.string())
          .default([])
          .describe('Arguments, one per element, e.g. ["--write", "report.md"]'),
        why: z
          .string()
          .optional()
          .describe('One line on what this run is for; kept on the record'),
      }),
      execute: async ({ tool, command, args: argv, why }) => {
        const resolved = await resolveShelfCommand(tenantId, tool, command)
        if ('error' in resolved) return { status: 'unavailable', reason: resolved.error }
        const runner = configuredDeskRunner()
        if (!runner) return { status: 'unavailable', reason: 'No desk is configured for this deployment.' }
        const timeoutMs = resolved.manifest.defaultTimeoutMs ?? 60_000
        const outcome = await execOnDesk({
          deskId: deskIdFor(tenantId, person.id),
          command: [resolved.bin, ...argv],
          cwd: GUEST_HOME,
          timeoutMs,
          outputLimitKb: 64,
        })
        await recordDeskLedgerEvent({
          tenantId,
          personId: person.id,
          runId,
          kind: 'shell_command',
          detail: {
            command: [resolved.bin, ...argv].join(' '),
            cwd: '.',
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            output: outcome.output,
            outputTruncated: outcome.outputTruncated,
            ...(why ? { reason: why } : {}),
          },
        }).catch(() => undefined)
        return {
          status: outcome.status,
          exitCode: outcome.exitCode,
          output: outcome.output,
          ...(outcome.outputTruncated ? { note: 'Output was truncated.' } : {}),
        }
      },
    }),
  ]
}
