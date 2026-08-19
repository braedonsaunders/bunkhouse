/**
 * Ranked recall is useful context, not a reason an employee becomes unable to
 * answer. Pinned memory remains mandatory; optional relevance degrades with a
 * durable warning after its database-level retry is exhausted.
 */
import assert from 'node:assert/strict'
import { runMemories } from '../src/lib/agent-runs'

const binding = { personId: '11111111-1111-4111-8111-111111111111', roleSlug: null }
const pinned = {
  id: '22222222-2222-4222-8222-222222222222',
  scope: 'agent' as const,
  slug: 'cash-reporting-policy',
  title: 'Cash reporting policy',
  body: 'Always reconcile the bank balance before reporting it.',
}

let warned = 0
const notes = await runMemories(
  { tenantId: '33333333-3333-4333-8333-333333333333', agent: binding, query: 'try again' },
  {
    pinned: async () => [pinned],
    relevant: async () => { throw new Error('temporary database failure') },
    onRecallFailure: async () => { warned += 1 },
  },
)

assert.deepEqual(notes, [{ scope: 'agent', slug: pinned.slug, title: pinned.title, body: pinned.body }])
assert.equal(warned, 1, 'the run ledger receives one concise degradation notice')

await assert.rejects(
  runMemories(
    { tenantId: '33333333-3333-4333-8333-333333333333', agent: binding, query: 'try again' },
    {
      pinned: async () => { throw new Error('pinned memory unavailable') },
      relevant: async () => [],
    },
  ),
  /pinned memory unavailable/,
  'operator-pinned context must never be omitted silently',
)

console.log('memory resilience: ranked recall degrades to pinned memory, while pinned memory stays mandatory')
