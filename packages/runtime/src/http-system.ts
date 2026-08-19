import { jsonSchema, tool } from 'ai'
import { z } from 'zod'
import type { Ability } from './abilities'
import type { ActionCategory } from './types'

const ACTION_CATEGORIES = [
  'external_email',
  'internal_email',
  'record_write',
  'money_adjacent',
  'file_write',
  'phone_call',
  'sandbox',
  'desktop',
  'shared_folder',
  'background_job',
] as const satisfies readonly ActionCategory[]

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const headerNameSchema = z.string().trim().min(1).max(120).regex(HEADER_NAME_PATTERN, 'invalid HTTP header name')
  .refine((value) => !FORBIDDEN_REQUEST_HEADERS.has(value.toLowerCase()), 'request header is managed by Bunkhouse')

const operationPathSchema = z.string().startsWith('/').max(1_000).superRefine((path, context) => {
  if (path.startsWith('//') || path.includes('\\') || path.includes('?') || path.includes('#')) {
    context.addIssue({ code: 'custom', message: 'path must be a relative API path without a host, query, or fragment' })
  }
  for (const segment of path.split('/')) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      context.addIssue({ code: 'custom', message: 'path contains invalid percent encoding' })
      continue
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      context.addIssue({ code: 'custom', message: 'path cannot escape its API base path' })
    }
  }
})

const jsonObjectSchema = z.object({
  type: z.literal('object'),
  properties: z.record(z.string(), z.union([z.boolean(), z.record(z.string(), z.unknown())])).default({}),
  required: z.array(z.string()).default([]),
  additionalProperties: z.boolean().optional(),
}).superRefine((schema, context) => {
  const properties = new Set(Object.keys(schema.properties))
  for (const key of schema.required) {
    if (!properties.has(key)) {
      context.addIssue({ code: 'custom', path: ['required'], message: `required input "${key}" has no property schema` })
    }
  }
})

const operationSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1_000),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: operationPathSchema,
  category: z.enum(ACTION_CATEGORIES),
  inputSchema: jsonObjectSchema,
  /** Input keys copied into the URL query string. */
  query: z.array(z.string().min(1).max(120)).max(40).default([]),
  /** Input key holding the JSON request body. Omit for bodyless operations. */
  body: z.string().min(1).max(120).optional(),
  /** Provider-supported idempotency header, such as Idempotency-Key. */
  idempotencyHeader: headerNameSchema.optional(),
  /** Input key whose value is sent as the idempotency header. */
  idempotencyInput: z.string().min(1).max(120).optional(),
}).superRefine((operation, context) => {
  const placeholders = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!)
  const properties = new Set(Object.keys(operation.inputSchema.properties))
  for (const key of [...placeholders, ...operation.query]) {
    if (!properties.has(key)) {
      context.addIssue({ code: 'custom', path: ['inputSchema', 'properties'], message: `missing input property "${key}"` })
    }
  }
  if (operation.body && !properties.has(operation.body)) {
    context.addIssue({ code: 'custom', path: ['body'], message: `body input "${operation.body}" is not in inputSchema` })
  }
  if (operation.idempotencyHeader !== undefined && operation.idempotencyInput === undefined) {
    context.addIssue({ code: 'custom', path: ['idempotencyInput'], message: 'idempotencyInput is required with idempotencyHeader' })
  }
  if (operation.idempotencyInput && !properties.has(operation.idempotencyInput)) {
    context.addIssue({ code: 'custom', path: ['idempotencyInput'], message: `idempotency input "${operation.idempotencyInput}" is not in inputSchema` })
  }
})

export const httpSystemDefinitionSchema = z.object({
  baseUrl: z.string().url().max(2_000),
  auth: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }),
    z.object({ kind: z.literal('bearer') }),
    z.object({ kind: z.literal('header'), headerName: headerNameSchema }),
  ]),
  operations: z.array(operationSchema).min(1).max(50),
  healthCheck: z.object({
    operation: z.string().min(1).max(64),
    input: z.record(z.string(), z.unknown()).default({}),
  }),
}).superRefine((definition, context) => {
  let url: URL
  try {
    url = new URL(definition.baseUrl)
  } catch {
    return
  }
  if (url.protocol !== 'https:') {
    context.addIssue({ code: 'custom', path: ['baseUrl'], message: 'baseUrl must use https' })
  }
  if (new Set(definition.operations.map((operation) => operation.name)).size !== definition.operations.length) {
    context.addIssue({ code: 'custom', path: ['operations'], message: 'operation names must be unique' })
  }
  const health = definition.operations.find((operation) => operation.name === definition.healthCheck.operation)
  if (!health) {
    context.addIssue({ code: 'custom', path: ['healthCheck', 'operation'], message: 'health operation does not exist' })
  } else if (health.method !== 'GET') {
    context.addIssue({ code: 'custom', path: ['healthCheck', 'operation'], message: 'health operation must be read-only GET' })
  }
})

export type HttpSystemDefinition = z.infer<typeof httpSystemDefinitionSchema>
export type HttpSystemOperation = HttpSystemDefinition['operations'][number]

export type HttpSystemRequest = {
  url: string
  method: HttpSystemOperation['method']
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
}

export type HttpSystemResponse = {
  status: number
  statusText: string
  contentType?: string
  body: unknown
}

export type HttpSystemTransport = (request: HttpSystemRequest) => Promise<HttpSystemResponse>

function inputRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('System tool input must be an object.')
  }
  return input as Record<string, unknown>
}

function scalar(value: unknown, key: string): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  throw new Error(`"${key}" must be a string, number, or boolean.`)
}

export function buildHttpSystemRequest(args: {
  definition: HttpSystemDefinition
  operation: HttpSystemOperation
  input: unknown
  authValue?: string
  signal?: AbortSignal
}): HttpSystemRequest {
  const input = inputRecord(args.input)
  let path = args.operation.path
  path = path.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    if (input[key] === undefined || input[key] === null) throw new Error(`"${key}" is required in the URL path.`)
    return encodeURIComponent(scalar(input[key], key))
  })
  // Keep every authored path below the reviewed API base path. Constructing a
  // URL directly from a leading slash would silently discard `/v1` and a
  // protocol-relative path could send credentials to another host.
  const url = new URL(args.definition.baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
  for (const key of args.operation.query) {
    const value = input[key]
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, scalar(item, key))
    } else {
      url.searchParams.set(key, scalar(value, key))
    }
  }
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (args.definition.auth.kind === 'bearer') {
    if (!args.authValue) throw new Error('This system needs a bearer token before it can be used.')
    headers.Authorization = `Bearer ${args.authValue}`
  } else if (args.definition.auth.kind === 'header') {
    if (!args.authValue) throw new Error(`This system needs ${args.definition.auth.headerName} before it can be used.`)
    headers[args.definition.auth.headerName] = args.authValue
  }
  if (args.operation.idempotencyHeader && args.operation.idempotencyInput) {
    const value = input[args.operation.idempotencyInput]
    if (value === undefined || value === null || value === '') {
      throw new Error(`"${args.operation.idempotencyInput}" is required to prevent duplicate effects.`)
    }
    headers[args.operation.idempotencyHeader] = scalar(value, args.operation.idempotencyInput)
  }
  const bodyValue = args.operation.body ? input[args.operation.body] : undefined
  if (bodyValue !== undefined) headers['Content-Type'] = 'application/json'
  return {
    url: url.toString(),
    method: args.operation.method,
    headers,
    ...(bodyValue === undefined ? {} : { body: JSON.stringify(bodyValue) }),
    ...(args.signal ? { signal: args.signal } : {}),
  }
}

export function connectHttpSystem(args: {
  slug: string
  definition: HttpSystemDefinition
  authValue?: string
  transport: HttpSystemTransport
}): Ability[] {
  const definition = httpSystemDefinitionSchema.parse(args.definition)
  return definition.operations.map((operation) => ({
    name: `${args.slug}_${operation.name}`,
    category: operation.category,
    ...(operation.idempotencyInput
      ? { externalEffectKey: (input: unknown) => scalar(inputRecord(input)[operation.idempotencyInput!], operation.idempotencyInput!) }
      : {}),
    tool: tool({
      description: operation.description,
      inputSchema: jsonSchema(operation.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: async (input: unknown, options: unknown) => {
        const optionRecord = typeof options === 'object' && options !== null ? options as Record<string, unknown> : {}
        const signal = optionRecord.abortSignal instanceof AbortSignal ? optionRecord.abortSignal : undefined
        const request = buildHttpSystemRequest({ definition, operation, input, authValue: args.authValue, ...(signal ? { signal } : {}) })
        const response = await args.transport(request)
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`${operation.title} failed (${response.status}${response.statusText ? ` ${response.statusText}` : ''}).`)
        }
        return { status: response.status, data: response.body }
      },
    }),
  }))
}
