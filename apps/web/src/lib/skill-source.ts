import 'server-only'
import type { SkillFrontmatter, SkillSource } from '../db/schema'
import { parseSkillMarkdown, skillTitle, type SkillRepoRef } from './skill-format'

/**
 * Fetching skills from a repository, pinned to a commit.
 *
 * Two calls to the GitHub API do the whole job: one resolves the branch or tag
 * an operator asked for to the commit it points at right now, and one lists
 * that commit's tree. The bytes themselves come from raw.githubusercontent.com,
 * which is not subject to the API's hourly limit — so installing a thirty-file
 * skill costs two API calls, not thirty.
 *
 * The commit is the pin. Nothing here is ever fetched during a run: an install
 * copies the bytes into the tenant, and upstream moving afterwards shows up as
 * an offered update. A run last week has to stay explicable by what was
 * installed then, which it cannot be if the source can change underneath it.
 */

export { parseRepoInput, type SkillRepoRef } from './skill-format'

const API = 'https://api.github.com'
const RAW = 'https://raw.githubusercontent.com'

/** Bounds on what will be pulled in. Generous for real skills, small enough
 *  that a mistyped path cannot drag a whole monorepo into the tenant. */
const MAX_FILES = 200
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024
/** How many skills one install may bring in when a repo holds a collection. */
const MAX_SKILLS_PER_INSTALL = 100

/** Git tree modes that are not plain files: symlinks and submodules. Both can
 *  point outside the bundle, so neither is ever materialized. */
const SYMLINK_MODE = '120000'
const SUBMODULE_MODE = '160000'
const EXECUTABLE_MODE = '100755'

export type FetchedSkillFile = {
  /** Path relative to the skill directory. */
  path: string
  bytes: Uint8Array
  contentType: string
  isScript: boolean
}

export type FetchedSkill = {
  name: string
  title: string
  frontmatter: SkillFrontmatter
  body: string
  /** Path of the skill directory inside the repository. */
  path: string
  files: FetchedSkillFile[]
  hasScripts: boolean
}

export type FetchOutcome =
  | { ok: true; commitSha: string; ref: string; skills: FetchedSkill[] }
  | { ok: false; message: string }

type TreeEntry = { path: string; mode: string; type: string; size?: number }

const EXTENSION_TYPES: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  csv: 'text/csv',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/typescript',
  py: 'text/x-python',
  sh: 'application/x-sh',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

function contentTypeFor(path: string): string {
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : ''
  return EXTENSION_TYPES[extension] ?? 'application/octet-stream'
}

function githubHeaders(): Record<string, string> {
  const token = process.env.BUNKHOUSE_GITHUB_TOKEN?.trim()
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'bunkhouse',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function githubJson(url: string): Promise<{ ok: true; body: unknown } | { ok: false; message: string }> {
  let response: Response
  try {
    response = await fetch(url, { headers: githubHeaders(), cache: 'no-store' })
  } catch (error) {
    return { ok: false, message: `GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (response.status === 404) {
    return { ok: false, message: 'That repository, branch, or folder does not exist — or it is private.' }
  }
  if (response.status === 403 || response.status === 429) {
    return {
      ok: false,
      message:
        'GitHub is rate-limiting this server. Wait a few minutes and try again, or set a GitHub token on the deployment to raise the limit.',
    }
  }
  if (!response.ok) return { ok: false, message: `GitHub answered ${response.status}.` }
  return { ok: true, body: await response.json() }
}

/** Resolve a branch, tag, or commit to the exact commit it names today. */
export async function resolveCommit(
  repo: string,
  ref?: string,
): Promise<{ ok: true; commitSha: string; ref: string } | { ok: false; message: string }> {
  const wanted = ref?.trim() || 'HEAD'
  const result = await githubJson(`${API}/repos/${repo}/commits/${encodeURIComponent(wanted)}`)
  if (!result.ok) return result
  const sha = (result.body as { sha?: unknown }).sha
  if (typeof sha !== 'string') return { ok: false, message: 'GitHub did not report a commit for that reference.' }
  return { ok: true, commitSha: sha, ref: wanted }
}

/**
 * Reject anything that could escape the bundle when it is written to disk.
 * The tree API returns POSIX paths, so a backslash, a drive letter, a leading
 * slash, or a `..` segment is malformed rather than merely unusual.
 */
function isSafePath(path: string): boolean {
  if (!path || path.length > 400) return false
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false
  if (/^[a-zA-Z]:/.test(path)) return false
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

async function fetchBlob(repo: string, commitSha: string, path: string): Promise<Uint8Array | null> {
  const response = await fetch(`${RAW}/${repo}/${commitSha}/${path.split('/').map(encodeURIComponent).join('/')}`, {
    headers: { 'User-Agent': 'bunkhouse' },
    cache: 'no-store',
  })
  if (!response.ok) return null
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * Read every skill under `path` at a pinned commit. A repository that holds a
 * whole collection yields one entry per `SKILL.md`; pointing at a single skill
 * folder yields exactly that one.
 */
export async function fetchSkills(input: SkillRepoRef): Promise<FetchOutcome> {
  const resolved = await resolveCommit(input.repo, input.ref)
  if (!resolved.ok) return resolved
  const { commitSha } = resolved

  const treeResult = await githubJson(`${API}/repos/${input.repo}/git/trees/${commitSha}?recursive=1`)
  if (!treeResult.ok) return treeResult
  const tree = (treeResult.body as { tree?: unknown }).tree
  if (!Array.isArray(tree)) return { ok: false, message: 'GitHub did not return a file listing for that commit.' }
  const entries = tree as TreeEntry[]

  const root = (input.path ?? '').replace(/^\/+|\/+$/g, '')
  const withinScope = (path: string) => !root || path === root || path.startsWith(`${root}/`)

  const manifests = entries.filter(
    (entry) => entry.type === 'blob' && withinScope(entry.path) && entry.path.split('/').at(-1) === 'SKILL.md',
  )
  if (manifests.length === 0) {
    return {
      ok: false,
      message: root
        ? `No SKILL.md was found under "${root}" in ${input.repo}.`
        : `No SKILL.md was found in ${input.repo}. Point at the folder that holds the skill.`,
    }
  }
  if (manifests.length > MAX_SKILLS_PER_INSTALL) {
    return {
      ok: false,
      message: `That location holds ${manifests.length} skills. Point at a narrower folder — at most ${MAX_SKILLS_PER_INSTALL} can be read at once.`,
    }
  }

  let bundleBytes = 0
  const skills: FetchedSkill[] = []

  for (const manifest of manifests) {
    const directory = manifest.path.slice(0, Math.max(0, manifest.path.length - 'SKILL.md'.length - 1))
    const directoryName = directory === '' ? input.repo.split('/')[1]! : directory.split('/').at(-1)!

    const manifestBytes = await fetchBlob(input.repo, commitSha, manifest.path)
    if (!manifestBytes) return { ok: false, message: `${manifest.path} could not be read from GitHub.` }
    const parsed = parseSkillMarkdown(new TextDecoder().decode(manifestBytes), directoryName)
    if (!parsed.ok) return { ok: false, message: `${manifest.path}: ${parsed.message}` }

    // Everything else in the skill's folder travels with it. A nested skill
    // belongs to itself, so its folder is not swept into the parent's bundle.
    const nested = manifests
      .filter((other) => other !== manifest && other.path.startsWith(`${directory}/`))
      .map((other) => other.path.slice(0, Math.max(0, other.path.length - 'SKILL.md'.length - 1)))

    const members = entries.filter((entry) => {
      if (entry.path === manifest.path) return false
      const inside = directory === '' ? true : entry.path.startsWith(`${directory}/`)
      if (!inside) return false
      if (nested.some((other) => entry.path === other || entry.path.startsWith(`${other}/`))) return false
      return entry.type === 'blob'
    })

    if (members.length > MAX_FILES) {
      return { ok: false, message: `"${parsed.skill.frontmatter.name}" holds ${members.length} files; at most ${MAX_FILES} are installed.` }
    }

    const files: FetchedSkillFile[] = []
    for (const member of members) {
      if (member.mode === SYMLINK_MODE || member.mode === SUBMODULE_MODE) continue
      const relative = directory === '' ? member.path : member.path.slice(directory.length + 1)
      if (!isSafePath(relative)) {
        return { ok: false, message: `"${member.path}" is not a path that can be installed safely.` }
      }
      if ((member.size ?? 0) > MAX_FILE_BYTES) {
        return { ok: false, message: `"${relative}" is larger than the ${MAX_FILE_BYTES / 1024 / 1024} MB per-file limit.` }
      }
      const bytes = await fetchBlob(input.repo, commitSha, member.path)
      if (!bytes) return { ok: false, message: `${member.path} could not be read from GitHub.` }
      bundleBytes += bytes.byteLength
      if (bundleBytes > MAX_BUNDLE_BYTES) {
        return { ok: false, message: `This install is larger than the ${MAX_BUNDLE_BYTES / 1024 / 1024} MB limit.` }
      }
      files.push({
        path: relative,
        bytes,
        contentType: contentTypeFor(relative),
        isScript: member.mode === EXECUTABLE_MODE || relative.startsWith('scripts/'),
      })
    }

    skills.push({
      name: parsed.skill.frontmatter.name,
      title: skillTitle(parsed.skill.frontmatter.name),
      frontmatter: parsed.skill.frontmatter,
      body: parsed.skill.body,
      path: directory,
      files,
      hasScripts: files.some((file) => file.isScript),
    })
  }

  return { ok: true, commitSha, ref: resolved.ref, skills }
}

/**
 * Whether the commit an installed skill is pinned to is still what its branch
 * points at. Returns null when upstream cannot be reached — an unreachable
 * repository is not the same as an available update, and must never be shown
 * as one.
 */
export async function checkForUpdate(source: SkillSource): Promise<{ commitSha: string } | null> {
  const resolved = await resolveCommit(source.repo, source.ref)
  if (!resolved.ok) return null
  if (resolved.commitSha === source.commitSha) return null
  return { commitSha: resolved.commitSha }
}
