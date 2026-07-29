import { tool, type Tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { ActionCategory, ApprovalGate, AutonomyResolver, RunSink } from './types'

/**
 * An ability is a tool plus the action category the autonomy dial governs it
 * under. Ungoverned abilities (category null) are read-only by convention —
 * anything that touches the world outside the run gets a category.
 *
 * Tool input/output are erased here (the loop treats tools opaquely, exactly
 * like the AI SDK's own ToolSet); `defineAbility` keeps authoring typed.
 */
export type Ability = {
  name: string
  category: ActionCategory | null
  /**
   * How an 'approval' dial applies to this ability.
   *
   * - `'each-call'` (default) — every call files its own request. Right for
   *   discrete acts: sending mail, moving money, writing to a record.
   * - `'continues'` — the dial still decides whether the ability may run at
   *   all, but it files no request of its own: it continues work an approved
   *   step already began, and cannot begin that work itself. A person who
   *   approves an errand approves the steps it takes; asking again for every
   *   click is not more oversight, it is noise that buries the decisions that
   *   matter. Abilities marked this way MUST be inert without the approved
   *   step that opens their session, and are recorded like any other.
   */
  approval?: 'each-call' | 'continues'
  tool: Tool<any, any>
}

export function defineAbility<INPUT, OUTPUT>(args: {
  name: string
  description: string
  category: ActionCategory | null
  approval?: 'each-call' | 'continues'
  inputSchema: z.ZodType<INPUT>
  execute: (input: INPUT) => Promise<OUTPUT>
}): Ability {
  return {
    name: args.name,
    category: args.category,
    ...(args.approval ? { approval: args.approval } : {}),
    tool: tool({
      description: args.description,
      inputSchema: args.inputSchema as z.ZodType<INPUT>,
      execute: async (input: INPUT) => args.execute(input),
    } as any),
  }
}

/** Result a governed tool returns to the model when the dial said 'approval'. */
export type PendingApprovalResult = {
  status: 'pending_approval'
  approvalId: string
  note: string
}

/** What a run is parked on when it asked a person and is waiting to hear back. */
export type PendingWait = {
  /** The mail thread the answer will arrive on. */
  threadId: string
  to: string
  question: string
  /** Days of silence before the agent nudges once, then decides how to proceed. */
  nudgeAfterDays: number
}

export type GovernanceState = {
  /** Set when a gated call filed an approval; the loop stops and suspends on it. */
  pendingApprovalId: string | null
  /** Set when the agent asked someone and chose to wait; the loop suspends on it. */
  pendingWait: PendingWait | null
}

/**
 * Wrap abilities with dial enforcement. 'forbidden' returns a refusal result
 * (the model is told, and the event is recorded); 'approval' files the request,
 * flags the loop to stop, and returns a pending marker; 'notify' and 'trusted'
 * execute — 'notify' additionally records a notify event for the manager feed.
 */
export function governedToolSet(args: {
  abilities: Ability[]
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
    const execute = base.execute.bind(base)
    set[ability.name] = {
      ...base,
      execute: async (input: unknown, options: unknown) => {
        const level = args.autonomy(category)
        if (level === 'forbidden') {
          return {
            status: 'forbidden',
            note: `The ${category} ability is disabled for you. Route this to a colleague who owns it or tell the requester it needs a human.`,
          }
        }
        if (level === 'approval' && ability.approval !== 'continues') {
          const description =
            args.describeAction?.(ability.name, input) ?? `${ability.name} with ${JSON.stringify(input)}`
          const { approvalId } = await args.approvals.request({
            category,
            description,
            action: { toolName: ability.name, input: input as Record<string, unknown> },
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
        if (level === 'notify') {
          const description =
            args.describeAction?.(ability.name, input) ?? `${ability.name} with ${JSON.stringify(input)}`
          await args.sink.event({
            kind: 'message',
            text: `Performed under notify-level autonomy (${category}): ${description}`,
          })
        }
        return execute(input as any, options as any)
      },
    } as ToolSet[string]
  }
  return set
}

/** The one always-present ability: procedure citations, recorded as events. */
export function citeProcedureAbility(args: {
  sink: RunSink
  procedures: { slug: string; version: number }[]
}): Ability {
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
