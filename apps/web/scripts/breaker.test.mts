import assert from 'node:assert/strict'
import { z } from 'zod'
import { defineAbility, governedToolSet, TOOL_FAILURE_LIMIT } from '@bunkhouse/runtime'

// A tool whose backing service is simply down, the way an unreachable file
// store is down: same error, every time, no matter what it is asked for.
let attempts = 0
const broken = defineAbility({
  name: 'create_document',
  description: 'always fails',
  category: 'file_write',
  inputSchema: z.object({ title: z.string() }),
  execute: async () => {
    attempts += 1
    throw new AggregateError([new Error('connect ECONNREFUSED 127.0.0.1:9000')], '')
  },
})

const notes: string[] = []
const tools = governedToolSet({
  abilities: [broken],
  autonomy: async () => 'trusted',
  approvals: { request: async () => ({ approvalId: 'never' }) },
  sink: {
    event: async (event) => {
      if (event.kind === 'tool_result') notes.push(String((event.output as { note?: string }).note ?? ''))
    },
    spend: async () => {},
  },
  state: { pendingApprovalId: null, pendingWait: null },
})

const call = async (title: string) =>
  (await tools.create_document!.execute!({ title }, { toolCallId: title, messages: [] })) as {
    error: string
    note: string
  }

// --- the real cause survives, instead of an empty string ---------------------
const first = await call('one')
assert.match(first.error, /ECONNREFUSED 127\.0\.0\.1:9000/, `the underlying reason is reported, got ${first.error}`)

// --- differing inputs still count as the same failure ------------------------
await call('two')
const third = await call('three')
assert.match(third.note, /will not be tried again/, `the breaker opens on failure ${TOOL_FAILURE_LIMIT}, note was: ${third.note}`)

// --- once open, the tool is not executed again -------------------------------
const before = attempts
const fourth = await call('four')
assert.equal(attempts, before, 'a call made after the breaker opened never reaches the service')
assert.match(fourth.note, /Do not call it again/, 'and the agent is told to stop and report')
assert.match(fourth.error, /ECONNREFUSED/, 'while still being told why')

console.log(`breaker: ok (service was called ${attempts} times for 4 attempts)`)
