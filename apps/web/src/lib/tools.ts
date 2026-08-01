import 'server-only'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  DEFAULT_AGENT_TOOL_POLICY,
  createAgentToolRuntime,
  createProcessSandboxRunner,
  type AgentToolRuntime,
} from '@appkit/agent-tools'
import { createDrizzleAgentToolStore } from '@appkit/agent-tools/drizzle'
import { isProcessSandboxSupported } from '@appkit/process-sandbox'
import { defineAbility, type Ability } from '@bunkhouse/runtime'
import { people, tenantSettings, TOOL_POLICY_KEY, type ToolPolicySettings } from '../db/schema'
import { db } from '../db/client'
import { agentHomePath } from './workspace'
import { TOOL_CATALOGUE } from './tool-catalogue'

export { TOOL_CATALOGUE }

/**
 * The tool shelf: command-line programs an agent may install and run.
 *
 * `run_shell` gives an agent whatever the image already ships. This is the
 * shelf above it — named tools with a pinned version, a declared risk, and a
 * health an operator can see. Adding one is a catalogue entry that can be
 * revoked, not a Dockerfile change nobody remembers making.
 *
 * Installing a tool and running one are separate questions, and neither answer
 * is permanent. Governance lives in @appkit/agent-tools; what bunkhouse owns is
 * which tools it trusts and where they run — always inside the agent's own home
 * directory, which is the only writable place a tool ever sees.
 */

type PersonRow = typeof people.$inferSelect

/** Where installed tools live. Deployment infrastructure, like the homes root. */
function toolsRoot(): string {
  return resolve(/* turbopackIgnore: true */ process.env.BUNKHOUSE_AGENT_TOOLS ?? '/data/agent-tools')
}

export function toolsSupported(): boolean {
  return isProcessSandboxSupported()
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
 * The runtime, bound to one tenant. The store is tenant-scoped so row-level
 * security is the outer boundary and the package's own predicates the inner one.
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
          .join(', ')}. ${tool.status === 'installed' ? 'Ready.' : 'Not installed yet.'}`,
    )
    .join('\n')
}

export function toolAbilities(args: { tenantId: string; person: PersonRow }): Ability[] {
  const { tenantId, person } = args
  if (!toolsSupported()) return []
  const app = db()
  const runtime = toolRuntime(tenantId)

  return [
    defineAbility({
      name: 'list_tools',
      description:
        'List the command-line tools on your shelf — what each one does, the commands it offers, and whether it is ready to use.',
      category: null,
      inputSchema: z.object({}),
      execute: async () => ({ shelf: await describeShelf(tenantId) }),
    }),
    defineAbility({
      name: 'run_tool',
      description:
        'Run one of the tools on your shelf against files in your workspace. Give the tool id, the command name, and its arguments as a list (there is no shell, so no pipes, quotes, or redirection — write output with the tool\'s own flag). Your workspace is the working directory and the only place a tool can write. If the tool is not installed yet it will be installed first. Some tools need a person to approve the run; you will be told when that happens.',
      category: 'shell',
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
          .describe('One line on what this run is for; shown to whoever approves it'),
      }),
      execute: async ({ tool, command, args: argv, why }) => {
        const workdir = await agentHomePath(tenantId, person.id)
        const result = await app.withTenantContext(tenantId, () =>
          runtime.execute({
            tenantId,
            toolId: tool,
            command,
            argv,
            workdir,
            installIfMissing: true,
            actor: person.id,
            ...(why ? { reason: why } : {}),
          }),
        )
        switch (result.outcome) {
          case 'ran':
            return {
              status: result.run.status,
              exitCode: result.run.exitCode,
              stdout: result.run.stdout,
              stderr: result.run.stderr,
              ...(result.run.truncated ? { note: 'Output was truncated.' } : {}),
            }
          case 'blocked':
            return {
              status: 'pending_approval',
              note: `${result.summary} Carry on with anything that does not depend on it, or say what you are waiting for.`,
            }
          case 'denied':
            return { status: 'denied', reason: result.reason, note: result.summary }
          case 'unavailable':
            return { status: 'unavailable', reason: result.reason, note: result.summary }
        }
      },
    }),
  ]
}
