import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildHttpSystemRequest,
  connectHttpSystem,
  httpSystemDefinitionSchema,
  type HttpSystemDefinition,
} from '../../../packages/runtime/src/http-system'

const definition: HttpSystemDefinition = {
  baseUrl: 'https://api.example.com/v1/',
  auth: { kind: 'bearer' },
  operations: [
    {
      name: 'update_customer',
      title: 'Update customer',
      description: 'Update one customer record.',
      method: 'PATCH',
      path: '/customers/{customerId}',
      category: 'record_write',
      inputSchema: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          notify: { type: 'boolean' },
          body: { type: 'object' },
          requestKey: { type: 'string' },
        },
        required: ['customerId', 'body', 'requestKey'],
      },
      query: ['notify'],
      body: 'body',
      idempotencyHeader: 'Idempotency-Key',
      idempotencyInput: 'requestKey',
    },
    {
      name: 'health',
      title: 'Check API',
      description: 'Check whether the API answers.',
      method: 'GET',
      path: '/health',
      category: 'record_write',
      inputSchema: { type: 'object', properties: {}, required: [] },
      query: [],
    },
  ],
  healthCheck: { operation: 'health', input: {} },
}

test('validates an authored definition and builds a bounded authenticated request', () => {
  const parsed = httpSystemDefinitionSchema.parse(definition)
  const request = buildHttpSystemRequest({
    definition: parsed,
    operation: parsed.operations[0]!,
    authValue: 'secret-token',
    input: {
      customerId: 'cus/a b',
      notify: true,
      body: { name: 'New name' },
      requestKey: 'run-123',
    },
  })
  assert.equal(request.url, 'https://api.example.com/v1/customers/cus%2Fa%20b?notify=true')
  assert.equal(request.method, 'PATCH')
  assert.equal(request.headers.Authorization, 'Bearer secret-token')
  assert.equal(request.headers['Idempotency-Key'], 'run-123')
  assert.equal(request.body, JSON.stringify({ name: 'New name' }))
})

test('rejects definitions whose health check can mutate the outside system', () => {
  const unsafe = structuredClone(definition)
  unsafe.healthCheck.operation = 'update_customer'
  assert.equal(httpSystemDefinitionSchema.safeParse(unsafe).success, false)
})

test('requires the provider idempotency value before a write request can leave', () => {
  const parsed = httpSystemDefinitionSchema.parse(definition)
  assert.throws(
    () => buildHttpSystemRequest({
      definition: parsed,
      operation: parsed.operations[0]!,
      authValue: 'secret-token',
      input: { customerId: 'cus_1', body: { name: 'New name' } },
    }),
    /requestKey.*required/,
  )
})

test('exposes each operation under its own category and namespaces its name', async () => {
  const requests: string[] = []
  const abilities = connectHttpSystem({
    slug: 'crm',
    definition,
    authValue: 'secret-token',
    transport: async (request) => {
      requests.push(request.url)
      return { status: 200, statusText: 'OK', body: { ok: true } }
    },
  })
  assert.deepEqual(abilities.map((ability) => [ability.name, ability.category]), [
    ['crm_update_customer', 'record_write'],
    ['crm_health', 'record_write'],
  ])
  const output = await abilities[1]!.tool.execute?.({}, { toolCallId: 'test', messages: [] } as never)
  assert.deepEqual(output, { status: 200, data: { ok: true } })
  assert.deepEqual(requests, ['https://api.example.com/v1/health'])
})

test('rejects operation paths and headers that could escape the reviewed request boundary', () => {
  const alternateHost = structuredClone(definition)
  alternateHost.operations[0]!.path = '//attacker.example/collect'
  assert.equal(httpSystemDefinitionSchema.safeParse(alternateHost).success, false)

  const traversal = structuredClone(definition)
  traversal.operations[0]!.path = '/../collect'
  assert.equal(httpSystemDefinitionSchema.safeParse(traversal).success, false)

  const managedHeader = structuredClone(definition)
  managedHeader.auth = { kind: 'header', headerName: 'Host' }
  assert.equal(httpSystemDefinitionSchema.safeParse(managedHeader).success, false)
})
