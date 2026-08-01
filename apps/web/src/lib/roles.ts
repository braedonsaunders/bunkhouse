import 'server-only'
import { asc, eq } from 'drizzle-orm'
import { ROLE_PACKS, type RolePack } from '@bunkhouse/roles'
import {
  procedureRevisions,
  procedures,
  roleDefs,
  type RoleAutonomyDefaults,
  type RoleDuty,
} from '../db/schema'
import { db } from '../db/client'

/**
 * One normalized role shape: builtin packs and tenant-authored defs.
 *
 * A role holds no copies of company resources. Its procedures, skills,
 * knowledge and systems are links, recorded on the resource as its assignment
 * and editable from either end. The one exception is a pack's starter
 * procedures: a pack is distributable data with no company behind it, so it
 * ships the text, and that text becomes a real versioned procedure the first
 * time the role is used here. After that the governed record is the doctrine
 * and the seed is history.
 */
export type RoleSeedProcedure = { slug: string; title: string; body: string }

export type Role = {
  slug: string
  title: string
  pitch: string
  description: string
  personality: { bio: string; tone: string[] }
  duties: RoleDuty[]
  autonomyDefaults: RoleAutonomyDefaults
  inboundPolicy: 'staff_only' | 'known_contacts' | 'anyone'
  suggestedSalaryUsd: number
  origin: 'builtin' | 'custom'
  /** role_defs row id for custom roles. */
  id?: string
  /** Starter procedures the pack ships, installed into the library on adoption. */
  seedProcedures: RoleSeedProcedure[]
}

function fromPack(pack: RolePack): Role {
  return {
    slug: pack.slug,
    title: pack.title,
    pitch: pack.pitch,
    description: pack.description,
    personality: pack.personality,
    duties: pack.duties.map((d) => ({ slug: d.slug, title: d.title, instruction: d.instruction, cron: d.cron })),
    autonomyDefaults: pack.autonomyDefaults,
    inboundPolicy: pack.inboundPolicy,
    suggestedSalaryUsd: pack.suggestedSalaryUsd,
    origin: 'builtin',
    seedProcedures: pack.procedures.map((p) => ({ slug: p.slug, title: p.title, body: p.body })),
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
    autonomyDefaults: def.autonomyDefaults,
    inboundPolicy: def.inboundPolicy,
    suggestedSalaryUsd: def.suggestedSalaryUsd,
    origin: 'custom',
    id: def.id,
    // A role built here links procedures instead of carrying them, so it has
    // nothing to seed — the picker is the whole of its procedure story.
    seedProcedures: [],
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

/** Every role an "applies to" picker can name — builtin and tenant-authored. */
export async function roleOptions(tenantId: string): Promise<{ value: string; label: string }[]> {
  const roles = await listRoles(tenantId)
  return roles.map((role) => ({ value: role.slug, label: role.title }))
}

/** The slug a role's starter procedure is installed under. */
export const seedProcedureSlug = (roleSlug: string, seedSlug: string) => `${roleSlug}-${seedSlug}`

/**
 * Install a role's starter procedures into the company's procedure library,
 * assigned to the role. Idempotent by slug: installing twice — or installing
 * after an agent was already onboarded from the role — adds nothing and never
 * overwrites text the company has since edited. The seed is a starting point,
 * not a live copy of the pack.
 *
 * Assumes an active tenant write scope.
 */
export async function installRoleProcedures(tenantId: string, role: Role): Promise<number> {
  const app = db()
  let installed = 0
  for (const seed of role.seedProcedures) {
    const [head] = await app.db
      .insert(procedures)
      .values({
        tenantId,
        slug: seedProcedureSlug(role.slug, seed.slug),
        title: seed.title,
        status: 'active',
        currentVersion: 1,
        assignment: { roles: [role.slug] },
        source: { type: 'role', role: role.slug, procedure: seed.slug },
      })
      .onConflictDoNothing()
      .returning({ id: procedures.id })
    if (!head) continue
    await app.db.insert(procedureRevisions).values({
      tenantId,
      procedureId: head.id,
      version: 1,
      body: seed.body,
      changeNote: `Installed with the ${role.title} role.`,
    })
    installed += 1
  }
  return installed
}
