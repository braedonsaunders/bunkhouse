import 'server-only'
import { asc, eq } from 'drizzle-orm'
import { ROLE_PACKS, type RolePack } from '@bunkhouse/roles'
import { roleDefs, type RoleAutonomyDefaults, type RoleDuty, type RoleProcedure } from '../db/schema'
import { db } from '../db/client'

/** One normalized role shape: builtin packs and tenant-authored defs. */
export type Role = {
  slug: string
  title: string
  pitch: string
  description: string
  personality: { bio: string; tone: string[] }
  duties: RoleDuty[]
  procedures: RoleProcedure[]
  autonomyDefaults: RoleAutonomyDefaults
  inboundPolicy: 'staff_only' | 'known_contacts' | 'anyone'
  suggestedSalaryUsd: number
  origin: 'builtin' | 'custom'
  /** role_defs row id for custom roles. */
  id?: string
}

function fromPack(pack: RolePack): Role {
  return {
    slug: pack.slug,
    title: pack.title,
    pitch: pack.pitch,
    description: pack.description,
    personality: pack.personality,
    duties: pack.duties.map((d) => ({ slug: d.slug, title: d.title, instruction: d.instruction, cron: d.cron })),
    procedures: pack.procedures,
    autonomyDefaults: pack.autonomyDefaults,
    inboundPolicy: pack.inboundPolicy,
    suggestedSalaryUsd: pack.suggestedSalaryUsd,
    origin: 'builtin',
  }
}

function fromDef(def: typeof roleDefs.$inferSelect): Role {
  return {
    slug: def.slug,
    title: def.title,
    pitch: def.pitch,
    description: def.description,
    personality: def.personality,
    duties: def.duties,
    procedures: def.procedures,
    autonomyDefaults: def.autonomyDefaults,
    inboundPolicy: def.inboundPolicy,
    suggestedSalaryUsd: def.suggestedSalaryUsd,
    origin: 'custom',
    id: def.id,
  }
}

/** Custom roles shadow builtins with the same slug (customized copies win). */
export async function listRoles(tenantId: string): Promise<Role[]> {
  const app = db()
  const custom = await app.withTenantContext(tenantId, () =>
    app.db.select().from(roleDefs).orderBy(asc(roleDefs.title)),
  )
  const customs = custom.map(fromDef)
  const shadowed = new Set(customs.map((r) => r.slug))
  return [...customs, ...ROLE_PACKS.filter((p) => !shadowed.has(p.slug)).map(fromPack)]
}

export async function getRole(tenantId: string, slug: string): Promise<Role | undefined> {
  const app = db()
  const [def] = await app.withTenantContext(tenantId, () =>
    app.db.select().from(roleDefs).where(eq(roleDefs.slug, slug)),
  )
  if (def) return fromDef(def)
  const pack = ROLE_PACKS.find((p) => p.slug === slug)
  return pack ? fromPack(pack) : undefined
}
