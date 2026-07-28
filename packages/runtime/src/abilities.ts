import { tool, type Tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { ActionCategory, ApprovalGate, AutonomyResolver, RunSink } from './types'

/**
 * An ability is a tool plus the action category the autonomy dial governs it
 * under. Ungoverned abilities (category null) are read-only by convention —
 * anything that touches the world outside the run gets a category.
 */
export type Ability<INPUT = unknown, OUTPUT = unknown> = {
  name: string
  category: ActionCategory | null
  tool: Tool<INPUT, OUTPUT>
}

export function defineAbility<INPUT, OUTPUT>(args: {
  name: string
  description: string
  category: ActionCategory | null
  inputSchema: z.ZodType<INPUT>
  execute: (input: INPUT) => Promise<OUTPUT>
}): Ability<INPUT, OUTPUT> {
  return {
    name: args.name,
    category: args.category,
    tool: tool({
      description: args.description,
      inputSchema: args.inputSchema,
      execute: async (input: INPUT) => args.execute(input),
    }) as Tool<INPUT, OUTPUT>,
  }
}

/** Result a governed tool returns to the model when the dial said 'approval'. */
export type PendingApprovalResult = {
  status: 'pending_approval'
  approvalId: string
  note: string
}

export type GovernanceState = {
  /** Set when a gated call filed an approval; the loop stops and suspends on it. */
  pendingApprovalId: string | null
}

/**
 * Wrap abilities with dial enforcement. 'forbidden' returns a refusal result
 * (the model is told, and the event is recorded); 'approval' files the request,
 * flags the loop to stop, and returns a pending marker; 'notify' and 'trusted'
 * execute — 'notify' additionally records a notify event for the manager feed.
 */
export function governedToolSet(args: {
  abilities: Ability<never, unknown>[]
  autonomy: AutonomyResolver
  approvals: ApprovalGate
  sink: RunSink
  state: GovernanceState
  /** Render the human-readable "what will happen" line for an approval. */
  describeAction?: (toolName: string, input: unknown) => string
}): ToolSet {
  const set: ToolSet = {}
  for (const ability of args.abilities) {
    const base = ability.tool
    if (ability.category === null || !base.execute) {
      set[ability.name] = base as ToolSet[string]
      continue
    }
    const category = ability.category
    const execute = base.execute.bind(base) as (input: never, options: never) => Promise<unknown>
    set[ability.name] = {
      ...base,
      execute: async (input: never, options: never) => {
        const level = args.autonomy(category)
        if (level === 'forbidden') {
          return {
            status: 'forbidden',
            note: `The ${category} ability is disabled for you. Route this to a colleague who owns it or tell the requester it needs a human.`,
          }
        }
        if (level === 'approval') {
          const description =
            args.describeAction?.(ability.name, input) ?? `${ability.name} with ${JSON.stringify(input)}`
          const { approvalId } = await args.approvals.request({
            category,
            description,
            action: { toolName: ability.name, input: input as unknown as Record<string, unknown> },
          })
          args.state.pendingApprovalId = approvalId
          await args.sink.event({ kind: 'approval_request', approvalId, category, description })
          const pending: PendingApprovalResult = {
            status: 'pending_approval',
            approvalId,
            note: 'This action needs human sign-off and has been queued. Finish up: summarize what is awaiting approval and stop.',
          }
          return pending
        }
        const output = await execute(input, options)
        return output
      },
    } as ToolSet[string]
  }
  return set
}

/** The one always-present ability: procedure citations, recorded as events. */
export function citeProcedureAbility(args: {
  sink: RunSink
  procedures: { slug: string; version: number }[]
}): Ability<{ slug: string }, { cited: boolean }> {
  const known = new Map(args.procedures.map((p) => [p.slug, p.version]))
  return defineAbility({
    name: 'cite_procedure',
    description:
      'Record that the work you are about to do follows a company procedure. Call this with the procedure slug before acting on it.',
    category: null,
    inputSchema: z.object({ slug: z.string() }),
    execute: async ({ slug }) => {
      const version = known.get(slug)
      if (version === undefined) return { cited: false }
      await args.sink.event({ kind: 'procedure_citation', slug, version })
      return { cited: true }
    },
  })
}
