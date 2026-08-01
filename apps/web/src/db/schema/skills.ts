import { bigint, boolean, index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@appkit/db'
import type { ResourceAssignment } from './assignment'

/**
 * Skills are portable competence: reusable know-how an agent can draw on,
 * written in the public `SKILL.md` format and installed from a repository
 * rather than authored here.
 *
 * They are deliberately NOT procedures. A procedure is binding company
 * doctrine — authored in-house, version-pinned per run, cited in the work. A
 * skill is a capability the agent reaches for when it is relevant, and it comes
 * from outside: `anthropics/skills`, a community collection, the company's own
 * repo. Only a skill's name and description sit in the system prompt; the body
 * is disclosed on demand, so a shelf of thirty skills costs almost no context.
 *
 * An installed skill is pinned to the exact commit it came from. Upstream
 * moving is surfaced as an available update, never applied silently — a run
 * that happened last week must stay explicable by what was installed then.
 */
export const skillStatus = pgEnum('skill_status', ['active', 'disabled'])

/**
 * Where an installed skill came from, kept in full so the exact bytes can be
 * traced back and an update can be offered against the same origin.
 *
 * `catalog` and `git` differ only in how the operator found it: a catalog
 * install still records the repository it resolved to. The union is open for
 * authored and uploaded skills without a schema change.
 */
export type SkillSource = {
  type: 'catalog' | 'git'
  /** `owner/repo` on the host. */
  repo: string
  /** Host the repository lives on; only github.com is fetched today. */
  host: string
  /** The branch or tag the operator asked for. */
  ref: string
  /** The commit that ref resolved to at install time. This is the pin. */
  commitSha: string
  /** Path to the skill directory inside the repository. */
  path: string
  /** Catalog entry slug, when the operator installed from the library. */
  catalogSlug?: string
}

/**
 * The `SKILL.md` front matter, as published. Only `name` and `description` are
 * required by the specification; the rest is carried verbatim so nothing is
 * lost between the repository and the operator reading it here.
 */
export type SkillFrontmatter = {
  name: string
  description: string
  license?: string
  /** Environment the author expects — packages, network access, host product. */
  compatibility?: string
  /** Space-separated tool pre-approvals. Advisory: bunkhouse governs by dial. */
  allowedTools?: string
  metadata?: Record<string, unknown>
  /** Keys outside the specification, preserved rather than dropped. */
  extra?: Record<string, unknown>
}

export const skills = pgTable(
  'skills',
  {
    id: id(),
    tenantId: tenantRef(),
    /** The skill's `name` from front matter; namespaces its files and tools. */
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    /** What it does and when to use it — the only part always in context. */
    description: text('description').notNull(),
    status: skillStatus('status').notNull().default('active'),
    currentVersion: integer('current_version').notNull().default(1),
    /** Same shape procedures use: everyone, role packs, or named agents. */
    assignment: jsonb('assignment').$type<ResourceAssignment>().notNull().default({}),
    source: jsonb('source').$type<SkillSource>().notNull(),
    /** As declared by the author; shown before an operator installs. */
    license: text('license'),
    /**
     * Whether the bundle ships executable files. Scripts run only through the
     * agent's sandboxed shell, so they are inert unless the company's shell
     * feature is on and the agent's autonomy allows it — but an operator should
     * see that a skill carries code before assigning it.
     */
    hasScripts: boolean('has_scripts').notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('skills_tenant_slug_key').on(t.tenantId, t.slug),
    index('skills_tenant_status_idx').on(t.tenantId, t.status, t.slug),
  ],
)

/**
 * One installed version of a skill. Append-only: updating from upstream writes
 * the next version rather than editing this one, so what an agent loaded on any
 * given day stays recoverable.
 */
export const skillRevisions = pgTable(
  'skill_revisions',
  {
    id: id(),
    tenantId: tenantRef(),
    skillId: uuid('skill_id').notNull(),
    version: integer('version').notNull(),
    /** The markdown below the front matter — what an agent reads on demand. */
    body: text('body').notNull(),
    frontmatter: jsonb('frontmatter').$type<SkillFrontmatter>().notNull(),
    /** The commit this version's bytes were read from. */
    commitSha: text('commit_sha').notNull(),
    /** Why this version exists: the first install, or what upstream changed. */
    changeNote: text('change_note'),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('skill_revisions_version_key').on(t.skillId, t.version),
    index('skill_revisions_tenant_idx').on(t.tenantId, t.skillId),
  ],
)

/**
 * A bundle member: everything in the skill directory other than `SKILL.md`
 * itself — `references/`, `assets/`, `scripts/`. Bytes live in object storage
 * exactly like the file ledger; the row is the manifest entry, and `sha256`
 * is what proves the materialized copy matches what was installed.
 */
export const skillFiles = pgTable(
  'skill_files',
  {
    id: id(),
    tenantId: tenantRef(),
    skillId: uuid('skill_id').notNull(),
    version: integer('version').notNull(),
    /** Path relative to the skill directory, e.g. `scripts/build.py`. */
    path: text('path').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    /** Tenant-scoped object key in the storage bucket. */
    storageKey: text('storage_key').notNull(),
    /** Under `scripts/`, or carrying an executable bit upstream. */
    isScript: boolean('is_script').notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('skill_files_path_key').on(t.skillId, t.version, t.path),
    index('skill_files_tenant_idx').on(t.tenantId, t.skillId, t.version),
  ],
)

export const SKILLS_TENANT_TABLES = ['skills', 'skill_revisions', 'skill_files'] as const
