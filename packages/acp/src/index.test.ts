import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACP_PROTOCOL_VERSION,
  BUNKHOUSE_ACP_CAPABILITIES,
  type AcpClient,
  type AcpSessionNotification,
} from './index'

test('advertises one explicit ACP version and governed extensions', () => {
  assert.equal(ACP_PROTOCOL_VERSION, 1)
  assert.deepEqual(BUNKHOUSE_ACP_CAPABILITIES, {
    protocolVersion: 1,
    sessionUpdates: true,
    toolCalls: true,
    cancellation: true,
    governedExtensions: true,
  })
})

test('the client contract receives standard ACP session updates', async () => {
  const received: AcpSessionNotification[] = []
  const client: AcpClient = {
    sessionUpdate: (notification) => {
      received.push(notification)
    },
  }
  await client.sessionUpdate({
    sessionId: 'session-1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
  })
  assert.equal(received[0]?.sessionId, 'session-1')
  assert.equal(received[0]?.update.sessionUpdate, 'agent_message_chunk')
})
