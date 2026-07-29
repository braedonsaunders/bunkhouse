import 'server-only'
import { and, eq } from 'drizzle-orm'
import { tenantSettings, MCP_INTEGRATIONS_KEY, type McpIntegrationEntry } from '../db/schema'
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
