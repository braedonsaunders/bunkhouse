import { z } from 'zod'
import { defineAbility, type Ability } from './abilities'
import type { RunSink } from './types'

/**
 * Skills, disclosed progressively.
 *
 * A skill is portable competence — how to build a well-formed spreadsheet, how
 * to lay out a proposal — written in the public `SKILL.md` format and installed
 * from a repository. Unlike a procedure, it is not binding doctrine: the agent
 * reaches for it when the work calls for it.
 *
 * Only the name and description of each skill sit in the system prompt, which
 * is what makes a shelf of thirty affordable. The instructions themselves
 * arrive when `load_skill` is called, and a skill that ships files has them
 * written into the agent's workspace at that moment — so the shell it already
 * has is the only way its scripts ever run, under the dial that already
 * governs the shell.
 */

export type BoundSkill = {
  slug: string
  title: string
  /** What it does and when to use it — the whole basis for choosing it. */
  description: string
  version: number
  /** The markdown instructions, handed over only when the skill is loaded. */
  body: string
  /** Whether the bundle carries files that must be written to the workspace. */
  hasFiles: boolean
}

/**
 * The catalogue line an agent chooses from. Deliberately terse: this text is
 * paid for on every single run, whether or not any skill is used.
 */
export function renderSkillIndex(skills: BoundSkill[]): string {
  if (skills.length === 0) return ''
  const lines = skills.map((skill) => `- ${skill.slug} — ${skill.description}`).join('\n')
  return `Skills available to you. Each one is a set of instructions for doing a particular kind of work well. The list below is all you know about them; when a task matches one, call load_skill with its name to read it before you start, and follow what it says. Do not guess at a skill's contents, and do not load one that has nothing to do with the work in front of you.\n\n${lines}`
}

/**
 * Disclosure is read-only, so this ability is ungoverned: reading instructions
 * changes nothing outside the run. Anything a skill then tells the agent to do
 * runs through the ability that actually does it — writing a file, sending
 * mail, running a shell command — each governed by its own dial exactly as it
 * would be if the agent had thought of it unaided. A skill grants no authority.
 */
export function loadSkillAbility(args: {
  sink: RunSink
  skills: BoundSkill[]
  /**
   * Write a skill's bundle into the agent's workspace and return the folder it
   * landed in. Injected so the runtime stays free of any particular workspace;
   * omitted, skills are text-only and their scripts are simply unavailable.
   */
  materialize?: (skill: BoundSkill) => Promise<{ path: string; files: string[] }>
}): Ability {
  const known = new Map(args.skills.map((skill) => [skill.slug, skill]))
  return defineAbility({
    name: 'load_skill',
    description:
      'Read the full instructions for one of the skills available to you. Call this before doing work the skill covers, then follow it.',
    category: null,
    inputSchema: z.object({
      name: z.string().describe('The skill name, exactly as listed in your available skills'),
    }),
    execute: async ({ name }) => {
      const skill = known.get(name.trim())
      if (!skill) {
        return {
          loaded: false,
          reason: `You have no skill called "${name}". Available: ${[...known.keys()].join(', ') || 'none'}.`,
        }
      }

      let workspace: { path: string; files: string[] } | null = null
      if (skill.hasFiles && args.materialize) {
        // A skill whose files cannot be written is still worth reading — the
        // instructions usually stand on their own — so a failure here degrades
        // to text rather than failing the call.
        workspace = await args.materialize(skill).catch(() => null)
      }

      await args.sink.event({ kind: 'skill_loaded', slug: skill.slug, version: skill.version })

      return {
        loaded: true,
        name: skill.slug,
        instructions: skill.body,
        ...(workspace
          ? {
              folder: workspace.path,
              files: workspace.files,
              note: `This skill's files are in ${workspace.path} in your workspace. Paths inside the instructions are relative to that folder.`,
            }
          : {}),
      }
    },
  })
}
