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

/**
 * The key an ability's result carries a picture under.
 *
 * An ability that can show the model what it just did — a browser step, a
 * rendered document, a camera — puts the frame here. Every layer that would
 * otherwise serialize the result takes the frame out first and hands the model
 * a real image instead of a wall of base-64. The rest of the result travels
 * unchanged: the picture is added to what the model is told, never a
 * replacement for it.
 */
export const ABILITY_FRAME_KEY = 'screenshot'

/** A picture an ability produced, ready to put in front of a model. */
export type AbilityFrame = {
  /** IANA media type of the bytes, e.g. `image/jpeg`. */
  mediaType: string
  /** The image itself, base-64 encoded. */
  data: string
  /** One line naming what the picture is of, shown alongside it. */
  label: string
}

function isAbilityFrame(value: unknown): value is AbilityFrame {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as Record<string, unknown>
  return (
    typeof frame.mediaType === 'string' &&
    frame.mediaType.startsWith('image/') &&
    typeof frame.data === 'string' &&
    frame.data.length > 0 &&
    typeof frame.label === 'string'
  )
}

/**
 * Split an ability's result into the picture it carries and everything else.
 * Anything that serializes a tool result — the run ledger, a call transcript,
 * the model output itself — calls this first so the bytes never land in JSON.
 */
export function takeAbilityFrame(output: unknown): { frame: AbilityFrame | null; rest: unknown } {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    return { frame: null, rest: output }
  }
  const record = output as Record<string, unknown>
  const candidate = record[ABILITY_FRAME_KEY]
  if (!isAbilityFrame(candidate)) return { frame: null, rest: output }
  const rest = { ...record }
  delete rest[ABILITY_FRAME_KEY]
  return { frame: candidate, rest }
}

/**
 * What the AI SDK accepts as a tool's model-facing output. Derived from the
 * SDK's own `Tool` type rather than restated, so the shape stays correct
 * across upgrades and the compiler checks what we build below.
 */
type ModelToolOutput = Awaited<ReturnType<NonNullable<Tool<any, any>['toModelOutput']>>>
type JsonToolOutput = Extract<ModelToolOutput, { type: 'json' }>['value']

/**
 * How an ability's result reaches the model. Without a frame this is exactly
 * the SDK's default (a string goes as text, anything else as JSON); with one,
 * the result becomes multimodal content — the JSON it would have sent, plus
 * the picture as a genuine image part the model can look at.
 */
function abilityModelOutput(output: unknown): ModelToolOutput {
  const { frame, rest } = takeAbilityFrame(output)
  if (!frame) {
    return typeof output === 'string'
      ? { type: 'text', value: output }
      : { type: 'json', value: output as JsonToolOutput }
  }
  return {
    type: 'content',
    value: [
      { type: 'text', text: `${frame.label}\n${JSON.stringify(rest)}` },
      { type: 'image-data', mediaType: frame.mediaType, data: frame.data },
    ],
  }
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
      // Generic on purpose: any ability whose result carries a frame is shown
      // to the model, and the runtime needs to know nothing about browsers.
      toModelOutput: ({ output }: { output: unknown }) => abilityModelOutput(output),
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
 * The longest any single tool call may take before the loop stops waiting on
 * it. A tool that never settles does not fail — it wedges the whole run, and
 * on a live call that reads as an agent saying "almost there" for five minutes
 * while nothing is happening. A DNS lookup with no deadline did exactly that.
 * Generous enough for a slow page or a real search; short enough that a caller
 * gets an answer, even if the answer is that it did not work.
 */
const TOOL_DEADLINE_MS = 60_000

/** Reject if the work has not settled by the deadline, without cancelling it. */
async function withDeadline<T>(name: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${name} did not finish within ${Math.round(TOOL_DEADLINE_MS / 1000)} seconds.`)),
          TOOL_DEADLINE_MS,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
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
    if (!base.execute) {
      set[ability.name] = base as ToolSet[string]
      continue
    }
    const category = ability.category
    const execute = base.execute.bind(base)
    set[ability.name] = {
      ...base,
      execute: async (input: unknown, options: unknown) => {
        // An ungoverned ability — reading a page, a search, a calculation — has
        // no dial to consult, but it still has to come back. It used to skip
        // this wrapper entirely, so when one threw there was no result, no
        // error and nothing on the ledger: the activity showed as running for
        // ever, the caller was told "almost there" indefinitely, and the fault
        // was invisible to everyone. Governance is what the category decides;
        // finishing is not optional for anything.
        const level = category === null ? 'trusted' : args.autonomy(category)
        if (category !== null && level === 'forbidden') {
          return {
            status: 'forbidden',
            note: `The ${category} ability is disabled for you. Route this to a colleague who owns it or tell the requester it needs a human.`,
          }
        }
        if (category !== null && level === 'approval' && ability.approval !== 'continues') {
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
        // Every tool is bounded, and every tool comes back with something.
        // A throw used to escape here and be recorded nowhere: the loop only
        // ledgers successful results, so a page that 403'd left a tool_call
        // with no outcome — the activity read as running for ever, the caller
        // was told "almost there" indefinitely, and nothing anywhere said what
        // had happened. Failing is fine; failing invisibly is not.
        try {
          return await withDeadline(ability.name, Promise.resolve(execute(input as any, options as any)))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const output = { error: message, note: 'That did not work. Say so plainly and try another way.' }
          await args.sink.event({ kind: 'tool_result', toolName: ability.name, output })
          return output
        }
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
