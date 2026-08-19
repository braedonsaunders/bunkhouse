import pg from 'pg'
import { sealSecret } from '@braedonsaunders/appkit-crypto'
import {
  E2E_AGENT_ID,
  E2E_CONTINUED_THREAD_ID,
  E2E_FAILED_THREAD_ID,
  E2E_QUEUE_THREAD_ID,
  E2E_SOURCE_THREAD_ID,
} from './e2e-fixtures'

const url = process.env.BUNKHOUSE_SUPER_URL
if (!url) throw new Error('BUNKHOUSE_SUPER_URL must be set')

const client = new pg.Client({ connectionString: url })
await client.connect()
try {
  const { rows: identities } = await client.query<{ tenant_id: string; user_id: string }>(
    `select t.id as tenant_id, u.id as user_id
       from tenants t
       join users u on u.email = 'owner@bunkhouse.local'
      where t.slug = 'bunkhouse-demo'`,
  )
  const identity = identities[0]
  if (!identity) throw new Error('The E2E tenant and owner were not seeded.')
  const { tenant_id: tenantId, user_id: userId } = identity

  await client.query(
    `insert into people
       (id, tenant_id, kind, status, name, title, email, responsibilities, personality, model_config)
     values ($1, $2, 'agent', 'active', 'Avery Chen', 'Accounts Receivable Clerk',
       'avery@bunkhouse.test', 'Follow up receivables and keep customer records current.',
       '{"bio":"I keep receivables moving.","tone":["clear"],"signoff":"Avery"}'::jsonb,
       '{"provider":"e2e","model":"test-model"}'::jsonb)
     on conflict (id) do nothing`,
    [E2E_AGENT_ID, tenantId],
  )
  await client.query(
    `insert into tenant_settings (tenant_id, key, value)
     values ($1, 'ai.providers', $2::jsonb)
     on conflict (tenant_id, key) do update set value = excluded.value`,
    [tenantId, JSON.stringify([{
      slug: 'e2e',
      provider: 'openai',
      label: 'E2E provider',
      sealedApiKey: sealSecret('e2e-not-a-real-provider-key'),
    }])],
  )

  const threadRows = [
    [E2E_SOURCE_THREAD_ID, 'Dawson receivable review', null, null, '4 hours'],
    [E2E_CONTINUED_THREAD_ID, 'Continuation of Dawson receivable review', E2E_SOURCE_THREAD_ID, 1, '3 hours'],
    [E2E_QUEUE_THREAD_ID, 'Month-end queue', null, null, '2 hours'],
    [E2E_FAILED_THREAD_ID, 'Recovery needed', null, null, '1 hour'],
  ] as const
  for (const [threadId, title, originThreadId, originMessageSeq, age] of threadRows) {
    await client.query(
      `insert into chat_threads
         (id, tenant_id, person_id, user_id, title, last_message_at, created_by, updated_by,
          origin_thread_id, origin_message_seq)
       values ($1, $2, $3, $4, $5, now() - $6::interval, $4, $4, $7, $8)
       on conflict (id) do nothing`,
      [threadId, tenantId, E2E_AGENT_ID, userId, title, age, originThreadId, originMessageSeq],
    )
  }

  const messages = [
    [E2E_SOURCE_THREAD_ID, 0, 'user', 'Review the Dawson receivable and draft a clear follow-up.'],
    [E2E_SOURCE_THREAD_ID, 1, 'agent', 'The balance is $1,240. I drafted a concise reminder with the invoice details.'],
    [E2E_CONTINUED_THREAD_ID, 0, 'user', 'Use a warmer tone for this customer.'],
    [E2E_CONTINUED_THREAD_ID, 1, 'agent', 'I softened the opening while keeping the amount and due date precise.'],
  ] as const
  for (const [threadId, seq, role, body] of messages) {
    await client.query(
      `insert into chat_messages (tenant_id, thread_id, seq, role, body)
       values ($1, $2, $3, $4, $5)
       on conflict (thread_id, seq) do nothing`,
      [tenantId, threadId, seq, role, body],
    )
  }

  const dispatches = [
    [E2E_QUEUE_THREAD_ID, 0, 'queue-running', 'Working now', 'running', 1, null],
    [E2E_QUEUE_THREAD_ID, 1, 'queue-next', 'Do this next', 'queued', 0, null],
    [E2E_FAILED_THREAD_ID, 0, 'queue-failed', 'Needs attention', 'failed', 1, 'The provider timed out.'],
  ] as const
  for (const [threadId, position, idempotencyKey, body, status, attempts, lastError] of dispatches) {
    await client.query(
      `insert into chat_dispatches
         (tenant_id, thread_id, user_id, position, idempotency_key, body, status, attempts,
          claimed_at, finished_at, last_error, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7::chat_dispatch_status, $8,
          case when $7::text = 'running' then now() else null end,
          case when $7::text = 'failed' then now() else null end,
          $9, $3, $3)
       on conflict (thread_id, idempotency_key) do nothing`,
      [tenantId, threadId, userId, position, idempotencyKey, body, status, attempts, lastError],
    )
  }
} finally {
  await client.end()
}

console.log('seeded component and lifecycle E2E fixtures')
