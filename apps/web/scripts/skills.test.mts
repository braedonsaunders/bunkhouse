import assert from 'node:assert/strict'
import { parseRepoInput, parseSkillMarkdown, skillTitle } from '../src/lib/skill-format'

/**
 * The two places a skill install can go quietly wrong: misreading the address
 * an operator pasted, and accepting a SKILL.md that does not conform. Both are
 * pure functions, so both are checked here without reaching the network — the
 * fetch itself is exercised against a real repository by hand.
 */

// --- repository addresses ---------------------------------------------------
// Operators paste whatever they had on screen; all of these mean one thing.
for (const [input, expected] of [
  ['anthropics/skills', { repo: 'anthropics/skills' }],
  ['anthropics/skills/skills/pdf', { repo: 'anthropics/skills', path: 'skills/pdf' }],
  ['https://github.com/anthropics/skills', { repo: 'anthropics/skills' }],
  [
    'https://github.com/anthropics/skills/tree/main/skills/docx',
    { repo: 'anthropics/skills', ref: 'main', path: 'skills/docx' },
  ],
  // A link straight at the manifest still names the skill's folder.
  [
    'https://github.com/anthropics/skills/blob/main/skills/docx/SKILL.md',
    { repo: 'anthropics/skills', ref: 'main', path: 'skills/docx' },
  ],
  ['git@github.com:anthropics/skills.git', { repo: 'anthropics/skills' }],
] as const) {
  const parsed = parseRepoInput(input)
  assert.ok(parsed.ok, `${input} should parse`)
  assert.deepEqual(parsed.ref, expected, input)
}

assert.ok(!parseRepoInput('https://gitlab.com/owner/repo').ok, 'only GitHub is fetched today')
assert.ok(!parseRepoInput('   ').ok, 'an empty address is refused')
assert.ok(!parseRepoInput('just-a-name').ok, 'owner/name is required')

// --- SKILL.md -------------------------------------------------------------
const valid = `---
name: pdf
description: "Do PDF things: merge, split, and fill."
license: Proprietary
---

# Working with PDFs
Do the thing.
`

const parsed = parseSkillMarkdown(valid, 'pdf')
assert.ok(parsed.ok, 'a conforming skill parses')
assert.equal(parsed.skill.frontmatter.name, 'pdf')
// A quoted description containing a colon is ordinary and must survive.
assert.equal(parsed.skill.frontmatter.description, 'Do PDF things: merge, split, and fill.')
assert.equal(parsed.skill.frontmatter.license, 'Proprietary')
assert.ok(parsed.skill.body.startsWith('# Working with PDFs'), 'body excludes the front matter')

// Block scalars are common in real skills and must not be flattened wrongly.
const block = parseSkillMarkdown('---\nname: a\ndescription: |-\n  Multi\n  line\n---\nbody', 'a')
assert.ok(block.ok)
assert.equal(block.skill.frontmatter.description, 'Multi\nline')

// Authored on Windows: neither a BOM nor CRLF is a reason to refuse a skill.
assert.ok(parseSkillMarkdown(valid.replace(/\n/g, '\r\n'), 'pdf').ok, 'CRLF is accepted')
assert.ok(parseSkillMarkdown(`﻿${valid}`, 'pdf').ok, 'a BOM is accepted')

// Unrecognised keys are preserved rather than dropped.
const extra = parseSkillMarkdown('---\nname: a\ndescription: x\nmodel: opus\n---\nbody', 'a')
assert.ok(extra.ok)
assert.equal(extra.skill.frontmatter.extra?.model, 'opus')

// The specification's rules, each of which protects a real invariant.
const rejected: [string, string, string][] = [
  ['# no front matter', 'x', 'front matter is required'],
  ['---\nname: pdf\ndescription: x\n---\nbody', 'other', 'name must match its folder'],
  ['---\nname: PDF\ndescription: x\n---\nbody', 'PDF', 'names are lowercase'],
  ['---\nname: pdf_tools\ndescription: x\n---\nbody', 'pdf_tools', 'underscores are not allowed'],
  ['---\nname: -pdf\ndescription: x\n---\nbody', '-pdf', 'no leading hyphen'],
  ['---\nname: claude\ndescription: x\n---\nbody', 'claude', 'reserved names are refused'],
  ['---\nname: a\n---\nbody', 'a', 'a description is required'],
  ['---\nname: a\ndescription: x\n---\n', 'a', 'instructions are required'],
  [`---\nname: a\ndescription: ${'x'.repeat(1100)}\n---\nbody`, 'a', 'the description is bounded'],
]
for (const [source, directory, why] of rejected) {
  assert.ok(!parseSkillMarkdown(source, directory).ok, why)
}

// --- presentation -----------------------------------------------------------
assert.equal(skillTitle('pdf'), 'PDF', 'a short one-word name reads as an acronym')
assert.equal(skillTitle('docx'), 'DOCX')
assert.equal(skillTitle('doc-coauthoring'), 'Doc Coauthoring')
assert.equal(skillTitle('internal-comms'), 'Internal Comms')

console.log('skills: ok')
