import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_AGENT_TOOL_POLICY,
  createAgentToolRuntime,
  createMemoryAgentToolStore,
  isSafeAgentTool,
  type SandboxCommand,
} from '@braedonsaunders/appkit-agent-tools'
import { TOOL_CATALOGUE } from '../src/lib/tool-catalogue'
import { createReadyStorageAccessor } from '../src/lib/storage-readiness'

const TENANT = '0194b8a2-3b74-7000-8000-000000000001'

// A transient object-store failure cannot poison every later file operation
// in the web process. Concurrent callers share one attempt; the next caller
// after a rejection gets a fresh client and readiness check.
{
  let creations = 0
  const readiness = createReadyStorageAccessor(() => {
    creations += 1
    return {
      ensureReady: async () => {
        if (creations === 1) throw new Error('temporary storage failure')
      },
    } as never
  })
  const first = readiness()
  assert.equal(readiness(), first)
  await assert.rejects(first.ready, /temporary storage failure/)
  const recovered = readiness()
  assert.notEqual(recovered, first)
  await recovered.ready
  assert.equal(creations, 2)
}

// --- the catalogue itself ---------------------------------------------------
// Importing the module already ran every manifest through defineAgentTool, so
// reaching this line means all six validate.
assert.ok(TOOL_CATALOGUE.length >= 6, 'the shelf should not be empty')
assert.equal(
  new Set(TOOL_CATALOGUE.map((tool) => tool.id)).size,
  TOOL_CATALOGUE.length,
  'tool ids must be unique',
)

for (const tool of TOOL_CATALOGUE) {
  assert.equal(tool.sourceKind, 'npm-package', `${tool.id} should install from npm`)
  assert.match(
    tool.packageVersion ?? '',
    /^\d+\.\d+\.\d+$/,
    `${tool.id} must pin an exact version; a range would let the bytes change under an approval`,
  )
  assert.equal(
    tool.requiresNetwork,
    false,
    `${tool.id} transforms files in the workspace and has no business reaching out`,
  )
  assert.ok(isSafeAgentTool(tool), `${tool.id} should qualify for allow_safe`)
  assert.ok(tool.limits?.cpuSeconds, `${tool.id} must declare a CPU ceiling`)
  assert.ok(tool.bins.every((bin) => bin.healthCheckArgs?.length), `${tool.id} needs a health check`)
}

// --- the flow, with the sandbox stubbed -------------------------------------
const root = await mkdtemp(join(tmpdir(), 'bunkhouse-tools-'))
const commands: SandboxCommand[] = []

const runtime = createAgentToolRuntime({
  store: createMemoryAgentToolStore(),
  installRoot: join(root, 'tools'),
  // Bunkhouse's shipped defaults: a person approves adding a tool to the host,
  // and a safe tool then runs unreviewed.
  policy: () => DEFAULT_AGENT_TOOL_POLICY,
  runner: async (command) => {
    commands.push(command)
    if (command.args[0] === 'install') {
      const { mkdir, writeFile } = await import('node:fs/promises')
      const binDir = join(command.cwd, 'node_modules', '.bin')
      await mkdir(binDir, { recursive: true })
      for (const tool of TOOL_CATALOGUE) {
        for (const bin of tool.bins) await writeFile(join(binDir, bin.bin), '#!/bin/sh\n', 'utf8')
      }
    }
    return { status: 'completed', exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 3 }
  },
})

const workdir = join(root, 'home')
for (const manifest of TOOL_CATALOGUE) await runtime.register(TENANT, manifest, 'system')
assert.equal((await runtime.list(TENANT)).length, TOOL_CATALOGUE.length)

// Running a tool that is not installed asks about the install, not the run.
const first = await runtime.execute({
  tenantId: TENANT,
  toolId: 'prettier',
  command: 'prettier',
  argv: ['--write', 'report.md'],
  workdir,
  installIfMissing: true,
  actor: 'agent-one',
})
assert.equal(first.outcome, 'blocked', 'adding a tool to the host needs a person')
assert.equal(commands.length, 0, 'nothing ran before that was answered')
if (first.outcome !== 'blocked') throw new Error('unreachable')
assert.equal(first.approval.action, 'install')

await runtime.approve({ tenantId: TENANT, approvalId: first.approval.id, decidedBy: 'operator' })

const ran = await runtime.execute({
  tenantId: TENANT,
  toolId: 'prettier',
  command: 'prettier',
  argv: ['--write', 'report.md'],
  workdir,
  installIfMissing: true,
  actor: 'agent-one',
})
assert.equal(ran.outcome, 'ran', 'once installed, a safe tool runs unreviewed')
if (ran.outcome !== 'ran') throw new Error('unreachable')
assert.equal(ran.run.status, 'completed')

// The install reached the registry; the run did not, and could only write home.
const install = commands.find((command) => command.args[0] === 'install')
assert.ok(install)
assert.equal(install.network, 'host')
assert.ok(install.args.includes('--ignore-scripts'), 'registry lifecycle scripts stay off')

const execution = commands.at(-1)
assert.ok(execution)
assert.equal(execution.network, 'none')
assert.deepEqual(execution.writablePaths, [workdir])
assert.equal(execution.cwd, workdir)
assert.ok(execution.limits?.cpuSeconds, 'ceilings from the manifest reach the sandbox')
assert.ok(
  execution.readOnlyPaths?.some((path) => path.includes('tools')),
  'the installed tool is readable but not rewritable by the run',
)
assert.ok(!execution.environment.PATH?.includes(root), 'no host paths leak into the child')

// A second agent's tenant sees none of this.
assert.equal((await runtime.list('0194b8a2-3b74-7000-8000-000000000002')).length, 0)

await rm(root, { recursive: true, force: true })
console.log(`tools: ${TOOL_CATALOGUE.length} manifests valid, install gated, run isolated`)
