import 'server-only'
import { createDb, type AppkitDb, schema as identity } from '@braedonsaunders/appkit-db'
import * as bunkhouse from './schema'

// One db instance per process; Next dev hot-reloads module graphs, so the
// singleton lives on globalThis to avoid a new pg pool per reload.

export const schema = { ...identity, ...bunkhouse }
export type BunkhouseDb = AppkitDb<typeof schema>

type Runtime = typeof globalThis & { __bunkhouseDb?: BunkhouseDb }
const runtime = globalThis as Runtime

export function isDatabaseConfigured(): boolean {
  const hasTenantUrl = Boolean(process.env.BUNKHOUSE_DB_URL)
  const hasSuperUrl = Boolean(process.env.BUNKHOUSE_SUPER_URL)
  if (hasTenantUrl !== hasSuperUrl) {
    throw new Error('Configure both BUNKHOUSE_DB_URL and BUNKHOUSE_SUPER_URL, or omit both.')
  }
  return hasTenantUrl
}

function build(): BunkhouseDb {
  const url = process.env.BUNKHOUSE_DB_URL
  const superUrl = process.env.BUNKHOUSE_SUPER_URL
  if (!url || !superUrl) {
    throw new Error('BUNKHOUSE_DB_URL and BUNKHOUSE_SUPER_URL must be set (.env.local)')
  }
  return createDb({ url, superUrl, schema })
}

export function db(): BunkhouseDb {
  return (runtime.__bunkhouseDb ??= build())
}
