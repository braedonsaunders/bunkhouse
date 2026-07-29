/**
 * The skill library: a short, curated shelf of skills worth a main-street
 * company's time, each one click from installing. It is deliberately not a
 * mirror of everything published — an operator running a plumbing business
 * does not need a test-driven-development skill on their bookkeeper.
 *
 * Every entry below was read from its repository in July 2026: the folder
 * exists, its SKILL.md parses, and the licence line is quoted as the author
 * wrote it. Anything not on this shelf still installs — the Install from
 * repository drawer takes any GitHub address.
 *
 * `licence` is shown before an operator installs, and it matters: several of
 * the document skills are source-available rather than open source, which is
 * a decision the company should make knowingly rather than discover later.
 */

export type SkillLibraryEntry = {
  /** The skill's folder name, which is also its `name` in front matter. */
  slug: string
  label: string
  /** One operator-facing sentence: what an agent can do once it has this. */
  description: string
  group: string
  repo: string
  /** Path to the skill's folder inside the repository. */
  path: string
  /** As the author declares it in front matter. */
  licence: string
  /** Whether the bundle ships executable scripts, which need the shell dial. */
  hasScripts: boolean
}

export const SKILL_LIBRARY_GROUPS = [
  'Documents & spreadsheets',
  'Writing',
  'Design',
  'Building skills',
] as const

const ANTHROPIC = 'anthropics/skills'
/** The document skills ship under Anthropic's own terms, not an OSI licence. */
const SOURCE_AVAILABLE = 'Proprietary — source-available, see LICENSE.txt in the skill'
const REPO_TERMS = 'See LICENSE.txt in the skill'

export const SKILL_LIBRARY: SkillLibraryEntry[] = [
  {
    slug: 'docx',
    label: 'Word documents',
    description: 'Create, read, and edit .docx files — letters, reports, and templates with real formatting.',
    group: 'Documents & spreadsheets',
    repo: ANTHROPIC,
    path: 'skills/docx',
    licence: SOURCE_AVAILABLE,
    hasScripts: true,
  },
  {
    slug: 'xlsx',
    label: 'Spreadsheets',
    description: 'Build and fix spreadsheets: formulas, formatting, charts, and cleaning up messy tabular data.',
    group: 'Documents & spreadsheets',
    repo: ANTHROPIC,
    path: 'skills/xlsx',
    licence: SOURCE_AVAILABLE,
    hasScripts: true,
  },
  {
    slug: 'pdf',
    label: 'PDFs',
    description: 'Read, merge, split, and fill PDFs, including extracting tables and text from scanned documents.',
    group: 'Documents & spreadsheets',
    repo: ANTHROPIC,
    path: 'skills/pdf',
    licence: SOURCE_AVAILABLE,
    hasScripts: true,
  },
  {
    slug: 'pptx',
    label: 'Presentations',
    description: 'Produce and edit slide decks — proposals, quarterly reviews, anything that needs to present well.',
    group: 'Documents & spreadsheets',
    repo: ANTHROPIC,
    path: 'skills/pptx',
    licence: SOURCE_AVAILABLE,
    hasScripts: true,
  },
  {
    slug: 'doc-coauthoring',
    label: 'Document co-authoring',
    description: 'A structured way to draft proposals, specifications, and decision documents with a person.',
    group: 'Writing',
    repo: ANTHROPIC,
    path: 'skills/doc-coauthoring',
    licence: REPO_TERMS,
    hasScripts: false,
  },
  {
    slug: 'internal-comms',
    label: 'Internal communications',
    description: 'Status reports, leadership updates, and announcements written in a consistent house format.',
    group: 'Writing',
    repo: ANTHROPIC,
    path: 'skills/internal-comms',
    licence: REPO_TERMS,
    hasScripts: false,
  },
  {
    slug: 'canvas-design',
    label: 'Posters & visual design',
    description: 'Original .png and .pdf design work — flyers, notices, and simple marketing pieces.',
    group: 'Design',
    repo: ANTHROPIC,
    path: 'skills/canvas-design',
    licence: REPO_TERMS,
    hasScripts: true,
  },
  {
    slug: 'theme-factory',
    label: 'Document themes',
    description: 'Apply a consistent colour and type theme across the documents and decks agents produce.',
    group: 'Design',
    repo: ANTHROPIC,
    path: 'skills/theme-factory',
    licence: REPO_TERMS,
    hasScripts: true,
  },
  {
    slug: 'skill-creator',
    label: 'Skill authoring',
    description: 'Lets an agent write and refine new skills of your own, in the same format everything here uses.',
    group: 'Building skills',
    repo: ANTHROPIC,
    path: 'skills/skill-creator',
    licence: REPO_TERMS,
    hasScripts: true,
  },
]
