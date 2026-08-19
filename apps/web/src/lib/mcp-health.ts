import 'server-only'
import { connectMcpServers } from '@bunkhouse/runtime'
import type { McpIntegrationEntry } from '../db/schema'
import { db } from '../db/client'
import { listMcpIntegrations, readMcpHealth, recordMcpHealth } from './mcp-integrations'
import { refreshGrantIfDue } from './mcp-oauth'
import { resolveIntegrationHeaders } from './agent-abilities'
import { listAuthoredSystems, probeAuthoredSystem } from './authored-systems'

/**
 * Whether the outside systems still answer — asked on a schedule rather than
 * discovered by an agent at 8am.
 *
 * A connection fails silently by nature: the ability assembly drops a server it
 * cannot reach and the run carries on with a smaller toolbox, which is the
 * right behaviour for the run and useless as an alarm. Nothing else looks at a
 * system between the day it is connected and the day someone notices the work
 * it was supposed to do never happened.
 */

/** How stale a health reading may get before the pass dials the server again. */
const HEALTH_INTERVAL_MS = 60 * 60 * 1000

export type SystemProbe =
  | { ok: true; tools: { name: string; description: string }[] }
  | { ok: false; message: string }

/**
 * Reach one system exactly the way an agent would — same credential path, same
 * dial — and record what happened. An approximation here would report health
 * that the thing being measured does not share.
 */
export async function probeSystem(tenantId: string, entry: McpIntegrationEntry): Promise<SystemProbe> {
  const app = db()
  try {
    const headers = await app.withTenantContext(tenantId, () => resolveIntegrationHeaders(tenantId, entry))
    const connection = await connectMcpServers([
      { slug: entry.slug, url: entry.url, ...(headers ? { headers } : {}) },
    ])
    try {
      // Abilities arrive namespaced by slug so names cannot collide between
      // systems; the operator is looking at one, so show the vendor's name.
      const prefix = `${entry.slug}_`
      const tools = connection.abilities
        .map((ability) => ({
          name: ability.name.startsWith(prefix) ? ability.name.slice(prefix.length) : ability.name,
          description: (ability.tool.description ?? '').trim(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
      await app.withTenant(tenantId, () =>
        recordMcpHealth(tenantId, entry.slug, {
          status: 'ok',
          checkedAt: Date.now(),
          toolCount: tools.length,
        }),
      )
      return { ok: true, tools }
    } finally {
      await connection.close()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await app.withTenant(tenantId, () =>
      recordMcpHealth(tenantId, entry.slug, { status: 'failed', checkedAt: Date.now(), error: message }),
    )
    return { ok: false, message: `Could not reach ${entry.label}: ${message}` }
  }
}

/**
 * Keep every connection alive and watched: renew OAuth grants before they
 * lapse, and re-ask each server whether it still answers.
 *
 * Renewing early is the durable half. A refresh token is spent by its own use
 * and expires from disuse, so a company that works Monday to Friday can return
 * from a long weekend to a system that will not sign in and cannot be signed in
 * without a person. Touching it on a schedule keeps it current whether or not
 * an agent happened to need it.
 */
export async function systemsHousekeeping(
  tenantId: string,
): Promise<{ renewed: string[]; checked: number; failing: string[] }> {
  const app = db()
  const entries = await app.withTenantContext(tenantId, () => listMcpIntegrations(tenantId))
  const health = await app.withTenantContext(tenantId, () => readMcpHealth(tenantId))

  const renewed: string[] = []
  const failing: string[] = []
  let checked = 0

  for (const entry of entries) {
    // Renewal first: a probe on a lapsed grant would report a failure the pass
    // is about to fix anyway.
    try {
      if (await refreshGrantIfDue(tenantId, entry)) renewed.push(entry.label)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await app.withTenant(tenantId, () =>
        recordMcpHealth(tenantId, entry.slug, { status: 'failed', checkedAt: Date.now(), error: message }),
      )
      failing.push(`${entry.label}: ${message}`)
      continue
    }

    const last = health[entry.slug]?.checkedAt ?? 0
    if (Date.now() - last < HEALTH_INTERVAL_MS) continue
    checked += 1
    const probe = await probeSystem(tenantId, entry)
    if (!probe.ok) failing.push(probe.message)
  }

  const authored = await listAuthoredSystems(tenantId)
  for (const record of authored) {
    if (record.system.status !== 'active' || !record.activeRevision) continue
    const last = record.connection?.lastCheckedAt?.getTime() ?? 0
    if (Date.now() - last < HEALTH_INTERVAL_MS) continue
    checked += 1
    const activeRecord = { ...record, revision: record.activeRevision }
    const probe = await probeAuthoredSystem(tenantId, activeRecord)
    if (!probe.ok) failing.push(`${record.system.name}: ${probe.message}`)
  }

  return { renewed, checked, failing }
}
