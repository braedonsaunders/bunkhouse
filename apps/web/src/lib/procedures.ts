import type { ProcedureContent, ProcedureStep } from '../db/schema'

/**
 * Procedures are authored as structure and read as markdown. `content` is the
 * single authored source; `body` is rendered from it here on every write, so
 * the two can never drift. Revisions written before steps existed (and prose
 * shipped by role packs) carry no content — those render from their own body.
 *
 * Type-only imports from the schema keep this usable from client components.
 */

const indent = (text: string, pad = '   ') =>
  text
    .trim()
    .split('\n')
    .map((line) => (line.trim() ? `${pad}${line}` : ''))
    .join('\n')

/** The markdown an agent reads. Sections with nothing in them are left out. */
export function renderProcedureBody(content: ProcedureContent): string {
  const parts: string[] = []

  if (content.whenToUse.trim()) parts.push(`## When to use\n\n${content.whenToUse.trim()}`)

  if (content.steps.length > 0) {
    const steps = content.steps
      .map((step, i) => {
        const lines = [`${i + 1}. **${step.title.trim()}**`]
        if (step.detail.trim()) lines.push('', indent(step.detail))
        if (step.checkWithHuman) lines.push('', indent('> Stop here and get a human decision before carrying on.'))
        return lines.join('\n')
      })
      .join('\n\n')
    parts.push(`## Steps\n\n${steps}`)
  }

  const criteria = content.successCriteria.map((c) => c.trim()).filter(Boolean)
  if (criteria.length > 0) parts.push(`## Done when\n\n${criteria.map((c) => `- ${c}`).join('\n')}`)

  if (content.escalation.trim()) parts.push(`## Stop and escalate\n\n${content.escalation.trim()}`)

  return parts.join('\n\n')
}

/** Reject anything that would render an empty or unfollowable procedure. */
export function parseProcedureContent(raw: string): ProcedureContent {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('The procedure could not be read. Reopen it and try again.')
  }
  const source = parsed as Partial<ProcedureContent>
  const steps: ProcedureStep[] = (Array.isArray(source.steps) ? source.steps : [])
    .map((step, i) => ({
      id: typeof step?.id === 'string' && step.id ? step.id : `step-${i + 1}`,
      title: String(step?.title ?? '').trim(),
      detail: String(step?.detail ?? '').trim(),
      checkWithHuman: Boolean(step?.checkWithHuman),
    }))
    .filter((step) => step.title || step.detail)

  if (steps.length === 0) throw new Error('A procedure needs at least one step.')
  const untitled = steps.findIndex((step) => !step.title)
  if (untitled >= 0) throw new Error(`Step ${untitled + 1} needs a title.`)

  return {
    whenToUse: String(source.whenToUse ?? '').trim(),
    steps,
    successCriteria: (Array.isArray(source.successCriteria) ? source.successCriteria : [])
      .map((c) => String(c).trim())
      .filter(Boolean),
    escalation: String(source.escalation ?? '').trim(),
  }
}

/**
 * The starting point when an operator edits a revision that predates steps:
 * the existing prose is preserved verbatim as the first step, to be split up
 * rather than retyped. Nothing is dropped.
 */
export function contentFromLegacyBody(body: string): ProcedureContent {
  return {
    whenToUse: '',
    steps: [{ id: 'step-1', title: 'Original procedure', detail: body.trim(), checkWithHuman: false }],
    successCriteria: [],
    escalation: '',
  }
}
