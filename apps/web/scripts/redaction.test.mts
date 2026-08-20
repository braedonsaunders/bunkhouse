import assert from 'node:assert/strict'
import { z } from 'zod'
import {
  containsSecret,
  createRedactingSink,
  createStreamingRedactor,
  defineAbility,
  governedToolSet,
  redactSecretValue,
  redactSecrets,
  type RunEvent,
} from '@bunkhouse/runtime'

const SECRET = 'provider-secret-123'

assert.equal(redactSecrets(`before ${SECRET} after`, [SECRET]), 'before [redacted] after')
assert.equal(containsSecret({ nested: [`prefix-${SECRET}`] }, [SECRET]), true)
assert.deepEqual(redactSecretValue({ token: SECRET, safe: true }, [SECRET]), {
  token: '[redacted]',
  safe: true,
})

const stream = createStreamingRedactor([SECRET])
const streamed = [stream.push('before provider-se'), stream.push('cret-123 after'), stream.finish()].join('')
assert.equal(streamed, 'before [redacted] after')
assert.equal(streamed.includes(SECRET), false)

const events: RunEvent[] = []
const sink = createRedactingSink(
  {
    event: async (event) => {
      events.push(event)
    },
    spend: async () => {},
  },
  [SECRET],
)
await sink.event({ kind: 'tool_result', toolName: 'connector', output: { echoed: SECRET } })
assert.equal(JSON.stringify(events).includes(SECRET), false)

let executed = 0
const tools = governedToolSet({
  abilities: [
    defineAbility({
      name: 'send_somewhere',
      description: 'Send text.',
      category: 'external_email',
      inputSchema: z.object({ body: z.string() }),
      execute: async ({ body }) => {
        executed += 1
        return { body, serverEcho: SECRET }
      },
    }),
  ],
  autonomy: () => 'trusted',
  approvals: { request: async () => ({ approvalId: 'approval-1' }) },
  sink,
  state: { pendingApprovalId: null, pendingCredentialRequestId: null, pendingWait: null },
  secrets: [SECRET],
})

const blocked = await tools.send_somewhere!.execute!({ body: `leak ${SECRET}` }, {} as never)
assert.equal(executed, 0)
assert.match(JSON.stringify(blocked), /protected credential/)

const safe = await tools.send_somewhere!.execute!({ body: 'ordinary text' }, {} as never)
assert.equal(executed, 1)
assert.equal(JSON.stringify(safe).includes(SECRET), false)

console.log('redaction: streaming, ledgers, model output, and external ability inputs are protected')
