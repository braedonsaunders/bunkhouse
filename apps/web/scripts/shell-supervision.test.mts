import assert from 'node:assert/strict'
import {
  DEFAULT_SHELL_EXECUTION_POLICY,
  resolveShellExecutionPolicy,
  runShellRemotely,
} from '../src/lib/shell-sandbox'

const executionId = '018f-shell-supervision'
const startedAt = '2026-08-05T12:00:00.000Z'
const finishedAt = '2026-08-05T12:00:01.000Z'
const requests: { url: string; method: string; body?: Record<string, unknown> }[] = []
let starts = 0
let polls = 0

const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = String(input)
  const method = init?.method ?? 'GET'
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
  requests.push({ url, method, ...(body ? { body } : {}) })

  if (method === 'POST') {
    starts += 1
    if (starts === 1) throw new Error('response connection closed')
    return Response.json({
      executionId,
      status: 'running',
      startedAt,
      finishedAt: null,
      events: [{ sequence: 1, executionId, timestamp: startedAt, type: 'started' }],
      latestSequence: 1,
      replayTruncated: false,
      result: null,
    }, { status: 202 })
  }

  polls += 1
  if (polls === 1) throw new Error('poll disconnected')
  return Response.json({
    executionId,
    status: 'completed',
    startedAt,
    finishedAt,
    events: [],
    latestSequence: 3,
    replayTruncated: false,
    result: {
      executionId,
      status: 'completed',
      exitCode: 0,
      signal: null,
      startedAt,
      finishedAt,
      output: 'finished after reconnect\n',
      outputTruncated: false,
    },
  })
}

const outcome = await runShellRemotely(
  { url: 'http://shell.internal', token: 'secret' },
  {
    executionId,
    home: '/data/agent-homes/tenant/person',
    cwd: '/data/agent-homes/tenant/person/work',
    command: 'printf done',
    policy: DEFAULT_SHELL_EXECUTION_POLICY,
  },
  { fetch: request as typeof fetch, now: () => Date.parse(startedAt) },
)

assert.equal(starts, 2, 'a lost start response retries the same idempotent start')
assert.equal(polls, 2, 'a lost poll reconnects instead of failing the command')
assert.equal(requests[0]?.body?.executionId, executionId)
assert.equal(requests[1]?.body?.executionId, executionId)
assert.match(requests.at(-1)?.url ?? '', /after=1/)
assert.equal(outcome.status, 'completed')
assert.equal(outcome.executionId, executionId)
assert.equal(outcome.output, 'finished after reconnect\n')

assert.deepEqual(resolveShellExecutionPolicy(null), DEFAULT_SHELL_EXECUTION_POLICY)
assert.throws(
  () => resolveShellExecutionPolicy({ ...DEFAULT_SHELL_EXECUTION_POLICY, memoryMb: 64 }),
  /Shell memory limit must be a whole number from 256 to 8192/,
)

console.log('shell supervision: idempotent start, reconnect, retained result, and bounded tenant policy')
