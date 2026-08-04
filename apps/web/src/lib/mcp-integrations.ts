import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import {
  tenantSettings,
  MCP_HEALTH_KEY,
  MCP_INTEGRATIONS_KEY,
  type McpIntegrationEntry,
  type McpSystemHealth,
} from '../db/schema'
import { db } from '../db/client'

/**
 * Where the tenant's MCP connections live. Kept apart from the ability
 * assembly and the OAuth flow so both can read and write the same record
 * without importing each other.
 */

export async function listMcpIntegrations(tenantId: string): Promise<McpIntegrationEntry[]> {
  const app = db()
  const [row] = await app.db
    .select({ value: tenantSettings.value })
    .from(tenantSettings)
    .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, MCP_INTEGRATIONS_KEY)))
  return (row?.value as McpIntegrationEntry[] | undefined) ?? []
}

export async function saveMcpIntegrations(tenantId: string, entries: McpIntegrationEntry[]): Promise<void> {
  const app = db()
  await app.db
    .insert(tenantSettings)
    .values({ tenantId, key: MCP_INTEGRATIONS_KEY, value: entries })
    .onConflictDoUpdate({
      target: [tenantSettings.tenantId, tenantSettings.key],
      set: { value: entries, updatedAt: new Date() },
    })
}

export type McpHealthBySlug = Record<string, McpSystemHealth>

export async function readMcpHealth(tenantId: string): Promise<McpHealthBySlug> {
  const app = db()
  const [row] = await app.db
    .select({ value: tenantSettings.value })
    .from(tenantSettings)
    .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, MCP_HEALTH_KEY)))
  return (row?.value as McpHealthBySlug | undefined) ?? {}
}

/**
 * Record how one system answered, merging in the database rather than in this
 * process. Two checks finishing together — the housekeeping pass and an
 * operator opening the Tools tab — would otherwise each write the whole map
 * from its own stale copy and drop the other's result. `jsonb ||` merges the
 * one key server-side, so neither has to have read the other first.
 */
export async function recordMcpHealth(
  tenantId: string,
  slug: string,
  health: McpSystemHealth,
): Promise<void> {
  const app = db()
  const patch = JSON.stringify({ [slug]: health })
  await app.db
    .insert(tenantSettings)
    .values({ tenantId, key: MCP_HEALTH_KEY, value: { [slug]: health } })
    .onConflictDoUpdate({
      target: [tenantSettings.tenantId, tenantSettings.key],
      set: {
        value: sql`coalesce(${tenantSettings.value}, '{}'::jsonb) || ${patch}::jsonb`,
        updatedAt: new Date(),
      },
    })
}

/** Drop a disconnected system's health so a later reconnect starts unjudged. */
export async function forgetMcpHealth(tenantId: string, slug: string): Promise<void> {
  const app = db()
  await app.db
    .update(tenantSettings)
    .set({ value: sql`coalesce(${tenantSettings.value}, '{}'::jsonb) - ${slug}`, updatedAt: new Date() })
    .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, MCP_HEALTH_KEY)))
}
