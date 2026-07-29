import { parse as parseYaml } from 'yaml'
import type { SkillFrontmatter } from '../db/schema'

/**
 * The `SKILL.md` format, as published at agentskills.io/specification: YAML
 * front matter between `---` fences, then markdown instructions.
 *
 * Only `name` and `description` are required, and a conforming reader ignores
 * front-matter keys it does not recognise. We keep the unrecognised ones in
 * `extra` instead of dropping them — a skill written for another agent product
 * should read back here exactly as its author wrote it, and an operator
 * deciding whether to trust a skill deserves to see everything it declares.
 */

/** Bounds from the specification, enforced so a malformed skill fails at
 *  install rather than halfway through a run. */
const NAME_MAX = 64
const DESCRIPTION_MAX = 1024
const COMPATIBILITY_MAX = 500

/** Lowercase alphanumerics and single inner hyphens — no leading, trailing, or
 *  consecutive hyphens. */
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Reserved by the specification so a skill cannot impersonate the agent. */
const RESERVED_NAMES = new Set(['claude', 'anthropic'])

export type ParsedSkill = {
  frontmatter: SkillFrontmatter
  /** The markdown below the front matter, trimmed of surrounding blank lines. */
  body: string
}

export type SkillParseResult = { ok: true; skill: ParsedSkill } | { ok: false; message: string }

/**
 * Split the front matter from the body. The opening fence must be the first
 * line — a `---` further down is a horizontal rule, not a delimiter.
 */
function splitFrontmatter(source: string): { yaml: string; body: string } | null {
  // A BOM or CRLF line endings are common in files authored on Windows and
  // must not be the reason a valid skill is refused.
  const text = source.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
  const afterFence = text.indexOf('\n', end + 1)
  return {
    yaml: text.slice(4, end),
    body: afterFence === -1 ? '' : text.slice(afterFence + 1),
  }
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined

/**
 * Parse and validate one `SKILL.md`. `directoryName` is the folder the file
 * came from: the specification requires `name` to match it, which is what
 * makes a skill's identity stable across the repositories that vendor it.
 */
export function parseSkillMarkdown(source: string, directoryName: string): SkillParseResult {
  const split = splitFrontmatter(source)
  if (!split) {
    return { ok: false, message: 'SKILL.md must open with YAML front matter fenced by --- lines.' }
  }

  let raw: unknown
  try {
    raw = parseYaml(split.yaml)
  } catch (error) {
    return { ok: false, message: `The front matter is not valid YAML: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'The front matter must be a set of key-value pairs.' }
  }
  const fields = raw as Record<string, unknown>

  const name = asString(fields.name)?.trim()
  if (!name) return { ok: false, message: 'The front matter must set a name.' }
  if (name.length > NAME_MAX) return { ok: false, message: `The name may be at most ${NAME_MAX} characters.` }
  if (!NAME_PATTERN.test(name)) {
    return {
      ok: false,
      message: `"${name}" is not a valid skill name — use lowercase letters, digits, and single hyphens between them.`,
    }
  }
  if (RESERVED_NAMES.has(name)) return { ok: false, message: `"${name}" is a reserved skill name.` }
  if (name !== directoryName) {
    return { ok: false, message: `The skill is named "${name}" but its folder is "${directoryName}"; these must match.` }
  }

  const description = asString(fields.description)?.trim()
  if (!description) return { ok: false, message: 'The front matter must set a description.' }
  if (description.length > DESCRIPTION_MAX) {
    return { ok: false, message: `The description may be at most ${DESCRIPTION_MAX} characters.` }
  }

  const compatibility = asString(fields.compatibility)?.trim()
  if (compatibility && compatibility.length > COMPATIBILITY_MAX) {
    return { ok: false, message: `Compatibility may be at most ${COMPATIBILITY_MAX} characters.` }
  }

  const license = asString(fields.license)?.trim()
  // Published as a space-separated string, but some authors write a list.
  const allowedToolsValue = fields['allowed-tools']
  const allowedTools = Array.isArray(allowedToolsValue)
    ? allowedToolsValue.map((entry) => asString(entry) ?? '').filter(Boolean).join(' ')
    : asString(allowedToolsValue)?.trim()

  const metadata =
    typeof fields.metadata === 'object' && fields.metadata !== null && !Array.isArray(fields.metadata)
      ? (fields.metadata as Record<string, unknown>)
      : undefined

  const known = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'])
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!known.has(key)) extra[key] = value
  }

  const body = split.body.trim()
  if (!body) return { ok: false, message: 'SKILL.md has front matter but no instructions below it.' }

  return {
    ok: true,
    skill: {
      frontmatter: {
        name,
        description,
        ...(license ? { license } : {}),
        ...(compatibility ? { compatibility } : {}),
        ...(allowedTools ? { allowedTools } : {}),
        ...(metadata ? { metadata } : {}),
        ...(Object.keys(extra).length > 0 ? { extra } : {}),
      },
      body,
    },
  }
}

export type SkillRepoRef = {
  /** `owner/repo`. */
  repo: string
  /** Branch, tag, or commit. Defaults to the repository's default branch. */
  ref?: string
  /** Directory within the repository; blank searches the whole repository. */
  path?: string
}

/**
 * Accept what an operator is likely to paste: a browser URL, an SSH remote, or
 * bare `owner/repo`. A `/tree/<ref>/<path>` URL carries the branch and folder
 * an operator was looking at, so read those out rather than making them
 * retype what they already had on screen.
 *
 * Pure, and deliberately kept beside the parser rather than beside the fetch:
 * this is the other half of "did we understand what the operator meant".
 */
export function parseRepoInput(input: string): { ok: true; ref: SkillRepoRef } | { ok: false; message: string } {
  const raw = input.trim()
  if (!raw) return { ok: false, message: 'Paste a repository address.' }

  let owner: string | undefined
  let name: string | undefined
  let ref: string | undefined
  let path: string | undefined

  const url = raw.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '')
  if (/^https?:\/\//.test(url)) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { ok: false, message: 'That is not a valid repository address.' }
    }
    if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') {
      return { ok: false, message: 'Skills can be installed from GitHub repositories.' }
    }
    const segments = parsed.pathname.split('/').filter(Boolean)
    owner = segments[0]
    name = segments[1]
    // .../tree/<ref>/<path...> and .../blob/<ref>/<path...>
    if ((segments[2] === 'tree' || segments[2] === 'blob') && segments[3]) {
      ref = segments[3]
      const rest = segments.slice(4)
      // A link straight to the file still names the skill's folder.
      if (rest.at(-1) === 'SKILL.md') rest.pop()
      if (rest.length > 0) path = rest.join('/')
    }
  } else {
    const segments = raw.split('/').filter(Boolean)
    owner = segments[0]
    name = segments[1]
    if (segments.length > 2) path = segments.slice(2).join('/')
  }

  if (!owner || !name) {
    return { ok: false, message: 'Give the repository as owner/name, or paste its GitHub address.' }
  }
  return {
    ok: true,
    ref: { repo: `${owner}/${name}`, ...(ref ? { ref } : {}), ...(path ? { path } : {}) },
  }
}

/**
 * A human title for a skill name. Skill names are lowercase-hyphenated by
 * specification; operators read them in tables, so present them as words. A
 * one-word name short enough to be a file format reads as an acronym — `pdf`
 * is "PDF", never "Pdf" — while anything longer is simply title-cased.
 */
export function skillTitle(name: string): string {
  const words = name.split('-').filter(Boolean)
  if (words.length === 1 && words[0]!.length <= 4) return words[0]!.toUpperCase()
  return words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' ')
}
