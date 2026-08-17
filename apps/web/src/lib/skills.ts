import 'server-only'
import { createHash } from 'node:crypto'
import { and, asc, count, eq } from 'drizzle-orm'
import { newTenantObjectKey, type Storage } from '@braedonsaunders/appkit-storage'
import { createStorageFromEnv } from '@braedonsaunders/appkit-storage/env'
import {
  skillFiles,
  skillRevisions,
  skills,
  type ResourceAssignment,
  type SkillSource,
} from '../db/schema'
import { db } from '../db/client'
import { fetchSkills, type FetchedSkill, type SkillRepoRef } from './skill-source'
import { bindsToAgent, type AgentBinding } from './assignment'

/**
 * Installing, updating, and assigning skills.
 *
 * An install copies the bytes into the tenant and pins the commit they came
 * from. Nothing reaches upstream during a run: the runtime reads only what is
 * stored here, so an agent's behaviour is a function of what the company chose
 * to install, not of what a repository looked like at the moment it ran.
 */

export type SkillRecord = typeof skills.$inferSelect
export type SkillRevisionRecord = typeof skillRevisions.$inferSelect
export type SkillFileRecord = typeof skillFiles.$inferSelect

/** Object storage for skill bundles — the same S3 the file ledger uses. */
let cached: { storage: Storage; ready: Promise<void> } | null = null
function storage(): { storage: Storage; ready: Promise<void> } {
  if (!cached) {
    const s = createStorageFromEnv(process.env as Record<string, string | undefined>)
    cached = { storage: s, ready: s.ensureReady() }
  }
  return cached
}

export type InstallOutcome =
  | { ok: true; installed: string[]; updated: string[] }
  | { ok: false; message: string }

/**
 * Write one fetched skill into the tenant as a new version. Used by both the
 * first install and every later update, so an updated skill goes through
 * exactly the same validation and storage path as a fresh one.
 */
async function writeSkillVersion(args: {
  tenantId: string
  fetched: FetchedSkill
  source: SkillSource
  changeNote: string
}): Promise<'installed' | 'updated'> {
  const { storage: s, ready } = storage()
  await ready
  const app = db()

  return app.withTenant(args.tenantId, async () => {
    const [existing] = await app.db
      .select()
      .from(skills)
      .where(and(eq(skills.tenantId, args.tenantId), eq(skills.slug, args.fetched.name)))

    const version = existing ? existing.currentVersion + 1 : 1
    const skillId = existing?.id

    // Bytes first: a half-written bundle with a row pointing at it would be
    // worse than a stored object nobody references yet.
    const stored: { path: string; contentType: string; sizeBytes: number; sha256: string; storageKey: string; isScript: boolean }[] = []
    for (const file of args.fetched.files) {
      const key = newTenantObjectKey({
        tenantId: args.tenantId,
        scope: `skills/${args.fetched.name}/${version}`,
        filename: file.path,
      })
      await s.put({ key, body: file.bytes, contentType: file.contentType, contentDisposition: 'attachment' })
      stored.push({
        path: file.path,
        contentType: file.contentType,
        sizeBytes: file.bytes.byteLength,
        sha256: createHash('sha256').update(file.bytes).digest('hex'),
        storageKey: key,
        isScript: file.isScript,
      })
    }

    let id: string
    if (existing) {
      await app.db
        .update(skills)
        .set({
          title: args.fetched.title,
          description: args.fetched.frontmatter.description,
          currentVersion: version,
          source: args.source,
          license: args.fetched.frontmatter.license ?? null,
          hasScripts: args.fetched.hasScripts,
          updatedAt: new Date(),
        })
        .where(eq(skills.id, skillId!))
      id = skillId!
    } else {
      const [row] = await app.db
        .insert(skills)
        .values({
          tenantId: args.tenantId,
          slug: args.fetched.name,
          title: args.fetched.title,
          description: args.fetched.frontmatter.description,
          currentVersion: version,
          assignment: {},
          source: args.source,
          license: args.fetched.frontmatter.license ?? null,
          hasScripts: args.fetched.hasScripts,
        })
        .returning()
      if (!row) throw new Error('The skill could not be recorded.')
      id = row.id
    }

    await app.db.insert(skillRevisions).values({
      tenantId: args.tenantId,
      skillId: id,
      version,
      body: args.fetched.body,
      frontmatter: args.fetched.frontmatter,
      commitSha: args.source.commitSha,
      changeNote: args.changeNote,
    })

    if (stored.length > 0) {
      await app.db.insert(skillFiles).values(
        stored.map((file) => ({
          tenantId: args.tenantId,
          skillId: id,
          version,
          path: file.path,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
          storageKey: file.storageKey,
          isScript: file.isScript,
        })),
      )
    }

    return existing ? 'updated' : 'installed'
  })
}

/**
 * Install every skill found at a repository location. A folder holding one
 * skill installs one; a collection installs all of them, which is what an
 * operator pasting a repository address expects.
 */
export async function installSkillsFromRepo(args: {
  tenantId: string
  ref: SkillRepoRef
  /** Set when the operator picked this from the curated library. */
  catalogSlug?: string
}): Promise<InstallOutcome> {
  const fetched = await fetchSkills(args.ref)
  if (!fetched.ok) return fetched

  const installed: string[] = []
  const updated: string[] = []
  for (const skill of fetched.skills) {
    const source: SkillSource = {
      type: args.catalogSlug ? 'catalog' : 'git',
      repo: args.ref.repo,
      host: 'github.com',
      ref: fetched.ref,
      commitSha: fetched.commitSha,
      path: skill.path,
      ...(args.catalogSlug ? { catalogSlug: args.catalogSlug } : {}),
    }
    const outcome = await writeSkillVersion({
      tenantId: args.tenantId,
      fetched: skill,
      source,
      changeNote: `Installed from ${args.ref.repo} at ${fetched.commitSha.slice(0, 7)}.`,
    })
    ;(outcome === 'installed' ? installed : updated).push(skill.title)
  }
  return { ok: true, installed, updated }
}

/**
 * Pull the latest version of an already-installed skill from the source it was
 * installed from. Writes the next version; the previous one stays on the
 * record, so what an agent read before the update is still recoverable.
 */
export async function updateInstalledSkill(args: {
  tenantId: string
  skillId: string
}): Promise<{ ok: true; version: number; changed: boolean } | { ok: false; message: string }> {
  const app = db()
  const [row] = await app.withTenantContext(args.tenantId, () =>
    app.db.select().from(skills).where(and(eq(skills.tenantId, args.tenantId), eq(skills.id, args.skillId))),
  )
  if (!row) return { ok: false, message: 'That skill is no longer installed.' }

  const fetched = await fetchSkills({ repo: row.source.repo, ref: row.source.ref, path: row.source.path })
  if (!fetched.ok) return fetched
  const skill = fetched.skills.find((candidate) => candidate.name === row.slug)
  if (!skill) {
    return { ok: false, message: `"${row.slug}" is no longer published at ${row.source.repo}/${row.source.path}.` }
  }
  if (fetched.commitSha === row.source.commitSha) {
    return { ok: true, version: row.currentVersion, changed: false }
  }

  await writeSkillVersion({
    tenantId: args.tenantId,
    fetched: skill,
    source: { ...row.source, commitSha: fetched.commitSha, ref: fetched.ref },
    changeNote: `Updated from ${row.source.commitSha.slice(0, 7)} to ${fetched.commitSha.slice(0, 7)}.`,
  })
  return { ok: true, version: row.currentVersion + 1, changed: true }
}

export async function listSkills(tenantId: string): Promise<SkillRecord[]> {
  const app = db()
  return app.withTenantContext(tenantId, () =>
    app.db.select().from(skills).where(eq(skills.tenantId, tenantId)).orderBy(asc(skills.title)),
  )
}

/** Every skill's current revision, for the reader in the record drawer. */
export async function listCurrentRevisions(tenantId: string): Promise<SkillRevisionRecord[]> {
  const app = db()
  return app.withTenantContext(tenantId, () =>
    app.db.select().from(skillRevisions).where(eq(skillRevisions.tenantId, tenantId)),
  )
}

export async function listSkillFiles(tenantId: string): Promise<SkillFileRecord[]> {
  const app = db()
  return app.withTenantContext(tenantId, () =>
    app.db.select().from(skillFiles).where(eq(skillFiles.tenantId, tenantId)).orderBy(asc(skillFiles.path)),
  )
}

export async function setSkillAssignment(args: {
  tenantId: string
  skillId: string
  assignment: ResourceAssignment
}): Promise<void> {
  const app = db()
  await app.withTenant(args.tenantId, async () => {
    await app.db
      .update(skills)
      .set({ assignment: args.assignment, updatedAt: new Date() })
      .where(and(eq(skills.tenantId, args.tenantId), eq(skills.id, args.skillId)))
  })
}

/**
 * Turn a skill off without losing it. A disabled skill keeps its versions, its
 * files, and its assignment — it simply stops being offered to agents, which
 * is what an operator means by "stop using this for now".
 */
export async function setSkillStatus(args: {
  tenantId: string
  skillId: string
  status: 'active' | 'disabled'
}): Promise<void> {
  const app = db()
  await app.withTenant(args.tenantId, async () => {
    await app.db
      .update(skills)
      .set({ status: args.status, updatedAt: new Date() })
      .where(and(eq(skills.tenantId, args.tenantId), eq(skills.id, args.skillId)))
  })
}

/** Remove a skill and its bundle entirely, objects included. */
export async function removeSkill(tenantId: string, skillId: string): Promise<void> {
  const app = db()
  const files = await app.withTenantContext(tenantId, () =>
    app.db.select().from(skillFiles).where(and(eq(skillFiles.tenantId, tenantId), eq(skillFiles.skillId, skillId))),
  )
  const { storage: s, ready } = storage()
  await ready
  for (const file of files) {
    // An object that has already gone is not a reason to strand the rows.
    await s.delete(file.storageKey).catch(() => undefined)
  }
  await app.withTenant(tenantId, async () => {
    await app.db.delete(skillFiles).where(and(eq(skillFiles.tenantId, tenantId), eq(skillFiles.skillId, skillId)))
    await app.db
      .delete(skillRevisions)
      .where(and(eq(skillRevisions.tenantId, tenantId), eq(skillRevisions.skillId, skillId)))
    await app.db.delete(skills).where(and(eq(skills.tenantId, tenantId), eq(skills.id, skillId)))
  })
}

/**
 * The skills one agent may draw on: active, and assigned to everyone, to the
 * role it holds, or to it by name. Resolved by the shared matcher, so an
 * operator's mental model of "applies to" is one model across every resource.
 */
export type BoundSkillRow = {
  skill: SkillRecord
  revision: SkillRevisionRecord
  /** Bundle members in this version — whether there is anything to write out. */
  fileCount: number
}

export async function skillsForAgent(args: {
  tenantId: string
  agent: AgentBinding
}): Promise<BoundSkillRow[]> {
  const app = db()
  return app.withTenantContext(args.tenantId, async () => {
    const rows = await app.db
      .select()
      .from(skills)
      .where(and(eq(skills.tenantId, args.tenantId), eq(skills.status, 'active')))
      .orderBy(asc(skills.title))
    const bound = rows.filter((row) => bindsToAgent(row.assignment, args.agent))
    if (bound.length === 0) return []

    const revisions = await app.db
      .select()
      .from(skillRevisions)
      .where(eq(skillRevisions.tenantId, args.tenantId))
    const counts = await app.db
      .select({ skillId: skillFiles.skillId, version: skillFiles.version, count: count() })
      .from(skillFiles)
      .where(eq(skillFiles.tenantId, args.tenantId))
      .groupBy(skillFiles.skillId, skillFiles.version)

    return bound.flatMap((skill) => {
      const revision = revisions.find((r) => r.skillId === skill.id && r.version === skill.currentVersion)
      if (!revision) return []
      const fileCount =
        counts.find((c) => c.skillId === skill.id && c.version === skill.currentVersion)?.count ?? 0
      return [{ skill, revision, fileCount }]
    })
  })
}

/** The bundle members of a skill's current version, with their bytes. */
export async function readSkillBundle(args: {
  tenantId: string
  skillId: string
  version: number
}): Promise<{ path: string; bytes: Uint8Array; isScript: boolean }[]> {
  const app = db()
  const rows = await app.withTenantContext(args.tenantId, () =>
    app.db
      .select()
      .from(skillFiles)
      .where(
        and(
          eq(skillFiles.tenantId, args.tenantId),
          eq(skillFiles.skillId, args.skillId),
          eq(skillFiles.version, args.version),
        ),
      ),
  )
  if (rows.length === 0) return []
  const { storage: s, ready } = storage()
  await ready
  const out: { path: string; bytes: Uint8Array; isScript: boolean }[] = []
  for (const row of rows) {
    const bytes = await s.getBytes(row.storageKey).catch(() => null)
    if (bytes) out.push({ path: row.path, bytes, isScript: row.isScript })
  }
  return out
}
