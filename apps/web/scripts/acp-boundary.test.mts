import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { AcpSessionNotification } from '@bunkhouse/acp'
import { createAcpRunProgress } from '@bunkhouse/runtime'

const root = new URL('../src/', import.meta.url)

async function filesBelow(directory: string): Promise<string[]> {
  const absolute = new URL(directory, root)
  const entries = await readdir(absolute, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? filesBelow(`${path}/`) : [path]
    }),
  )
  return nested.flat()
}

test('client components can depend on ACP but cannot import the employee runtime', async () => {
  const candidates = (await filesBelow('')).filter((path) => /\.(?:ts|tsx)$/.test(path))
  const violations: string[] = []
  for (const path of candidates) {
    const source = await readFile(new URL(path, root), 'utf8')
    if (/^[\s\S]*?['\"]use client['\"]/.test(source) && source.includes('@bunkhouse/runtime')) violations.push(path)
  }
  assert.deepEqual(violations, [])
})

test('runtime progress is translated to ACP session updates in order', async () => {
  const received: AcpSessionNotification[] = []
  const progress = createAcpRunProgress({
    sessionId: 'session-7',
    client: { sessionUpdate: (notification) => received.push(notification) },
  })

  await progress.onTextDelta?.('Working')
  await progress.onToolCall?.({ toolCallId: 'call-1', toolName: 'lookup_customer', input: { id: 7 } })
  await progress.onToolResult?.({ toolCallId: 'call-1', output: { found: true } })

  assert.deepEqual(
    received.map(({ sessionId, update }) => ({ sessionId, kind: update.sessionUpdate })),
    [
      { sessionId: 'session-7', kind: 'agent_message_chunk' },
      { sessionId: 'session-7', kind: 'tool_call' },
      { sessionId: 'session-7', kind: 'tool_call_update' },
    ],
  )
})

test('the ACP package remains free of UI, framework, provider, and server dependencies', async () => {
  const acpRoot = new URL('../../../packages/acp/src/', import.meta.url)
  const source = await readFile(new URL('index.ts', acpRoot), 'utf8')
  for (const forbidden of ['react', 'next', "from 'ai'", '@braedonsaunders/appkit-ai', 'server-only']) {
    assert.equal(source.includes(forbidden), false, `ACP source must not include ${forbidden}`)
  }
})
