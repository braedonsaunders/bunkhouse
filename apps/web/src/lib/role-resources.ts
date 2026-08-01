import 'server-only'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { memories, procedures, skills, type ResourceAssignment } from '../db/schema'
import { db } from '../db/client'
import { listMcpIntegrations, saveMcpIntegrations } from './mcp-integrations'
import { bindsToRole, withRole, withoutRole } from './assignment'

/**
 * A role's resources, read and written from the role's side of the link.
 *
 * The link itself is the resource's assignment — the same field the Company
 * resources screens edit — so there is one edge and one source of truth. This
 * module only offers the other end of it: the catalog an operator picks from
 * on the role, and the diff that turns a selection into assignment writes.
 */

/** The kinds of resource a role can be given. Duties are not one: they are the
 *  role's own standing work, scheduled per agent, not a shared object. */
export const ROLE_RESOURCE_KINDS = ['procedures', 'skills', 'notes', 'systems'] as const
export type RoleResourceKind = (typeof ROLE_RESOURCE_KINDS)[number]

export function isRoleResourceKind(value: string): value is RoleResourceKind {
  return (ROLE_RESOURCE_KINDS as readonly string[]).includes(value)
}

export type ResourceEntry = {
  /** What the link action addresses: a row id, or a slug for connected systems. */
  key: string
  title: string
  /** One line of context — version, description, kind — for the picker row. */
  detail: string
  assignment: ResourceAssignment
}

export type ResourceCatalog = Record<RoleResourceKind, ResourceEntry[]>

/**
 * Everything in the company a role could be given, with who each item already
 * applies to. One read for the whole catalog: the role screen shows both what
 * is linked and what could be, and those are the same list.
 */
export async function listResourceCatalog(tenantId: string): Promise<ResourceCatalog> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [procedureRows, skillRows, noteRows, systems] = await Promise.all([
      app.db.select().from(procedures).orderBy(asc(procedures.title)),
      app.db.select().from(skills).orderBy(asc(skills.title)),
      app.db
        .select()
        .from(memories)
        .where(and(eq(memories.scope, 'company'), eq(memories.status, 'active'), isNull(memories.validUntil)))
        .orderBy(asc(memories.title)),
      listMcpIntegrations(tenantId),
    ])
    return {
      procedures: procedureRows.map((row) => ({
        key: row.id,
        title: row.title,
        detail: `v${row.currentVersion} · ${row.status}`,
        assignment: row.assignment,
      })),
      skills: skillRows.map((row) => ({
        key: row.id,
        title: row.title,
        detail: row.description,
        assignment: row.assignment,
      })),
      notes: noteRows.map((row) => ({
        key: row.id,
        title: row.title,
        detail: `${row.kind}${row.pinned ? ' · pinned' : ''}`,
        assignment: row.assignment,
      })),
      systems: systems.map((entry) => ({
        key: entry.slug,
        title: entry.label,
        detail: entry.url,
        assignment: entry.assignment,
      })),
    }
  })
}

/** The keys of one kind currently linked to a role, for the picker's state. */
export function linkedKeys(entries: ResourceEntry[], roleSlug: string): string[] {
  return entries.filter((entry) => bindsToRole(entry.assignment, roleSlug)).map((entry) => entry.key)
}

/**
 * Rewrite one kind's links for one role: everything selected gains the role,
 * everything else in that kind loses it. Only rows whose assignment actually
 * changes are written, so an untouched resource keeps its updated_at — and its
 * place in "what changed recently" stays honest.
 *
 * A resource assigned to everyone is left alone: it already reaches this role,
 * and unlinking it here would quietly narrow it for the whole company. That
 * decision belongs on the resource, where the consequence is in view.
 */
export async function setRoleLinks(args: {
  tenantId: string
  roleSlug: string
  kind: RoleResourceKind
  keys: string[]
}): Promise<void> {
  const { tenantId, roleSlug, kind } = args
  const selected = new Set(args.keys)
  const app = db()
  const catalog = await listResourceCatalog(tenantId)
  const changes = catalog[kind].flatMap((entry) => {
    if (entry.assignment.everyone) return []
    const next = selected.has(entry.key)
      ? withRole(entry.assignment, roleSlug)
      : withoutRole(entry.assignment, roleSlug)
    return next === entry.assignment ? [] : [{ key: entry.key, assignment: next }]
  })
  if (changes.length === 0) return

  await app.withTenant(tenantId, async () => {
    if (kind === 'systems') {
      const entries = await listMcpIntegrations(tenantId)
      const byKey = new Map(changes.map((change) => [change.key, change.assignment]))
      await saveMcpIntegrations(
        tenantId,
        entries.map((entry) => {
          const assignment = byKey.get(entry.slug)
          return assignment ? { ...entry, assignment } : entry
        }),
      )
      return
    }
    const table = kind === 'procedures' ? procedures : kind === 'skills' ? skills : memories
    for (const change of changes) {
      await app.db
        .update(table)
        .set({ assignment: change.assignment, updatedAt: new Date() })
        .where(eq(table.id, change.key))
    }
  })
}
