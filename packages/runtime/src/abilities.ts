import { tool, type Tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { ActionCategory, ApprovalGate, AutonomyResolver, ExternalEffectGate, RunSink } from './types'
import { containsSecret, normalizeSecrets, redactSecrets, redactSecretValue } from './redaction'

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
  /**
   * Which dial governs this, and — where the answer depends on what is being
   * asked for — a function of the input rather than a fixed label.
   *
   * Fixed was wrong in a way that cost real money. `send_email` carried
   * 'external_email' whatever the address was, so mail to `dana@bunkhouse.local`
   * — a colleague in the directory — was governed by the external dial and
   * parked awaiting a human, while the identical message through
   * `email_colleague` was 'internal_email' and went straight through. Same
   * action, same recipient, two different answers decided by which tool the
   * model happened to reach for. Runs sat parked for hours having already paid
   * for every step it took to get there, and nobody was told, because the
   * notice goes by the mail that was not working.
   *
   * The governed loop resolves this before it decides anything, so what is
   * asked for is what is governed.
   */
  category: ActionCategory | null | ((input: unknown) => ActionCategory | null)
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

/** Categories whose adapters cross the run/desk boundary into another system. */
const EXTERNAL_EFFECT_CATEGORIES: ReadonlySet<ActionCategory> = new Set([
  'external_email',
  'internal_email',
  'record_write',
  'money_adjacent',
  'file_write',
  'phone_call',
  'shared_folder',
  'background_job',
])

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
  /**
   * The dial that governs this — or, where it depends on what is being asked
   * for, a function of the input. Resolved before anything is decided, so what
   * is asked for is what is governed. Synchronous by necessity: an approval is
   * filed before `execute` ever runs.
   */
  category: ActionCategory | null | ((input: INPUT) => ActionCategory | null)
  approval?: 'each-call' | 'continues'
  inputSchema: z.ZodType<INPUT>
  execute: (input: INPUT, context: { signal: AbortSignal }) => Promise<OUTPUT>
}): Ability {
  return {
    name: args.name,
    category:
      typeof args.category === 'function'
        ? (input: unknown) => (args.category as (i: INPUT) => ActionCategory | null)(input as INPUT)
        : args.category,
    ...(args.approval ? { approval: args.approval } : {}),
    tool: tool({
      description: args.description,
      inputSchema: args.inputSchema as z.ZodType<INPUT>,
      execute: async (input: INPUT, options: unknown) => {
        const optionRecord =
          typeof options === 'object' && options !== null ? (options as Record<string, unknown>) : {}
        const signal =
          optionRecord.abortSignal instanceof AbortSignal ? optionRecord.abortSignal : new AbortController().signal
        return args.execute(input, { signal })
      },
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
 *
 * How long is generous depends entirely on who is waiting, which is why this
 * is a property of the DISPOSITION and not of the ability. One minute is right
 * when someone is holding a phone; it is wrong for an assignment building a
 * spreadsheet, running a real command in the workspace, or waiting on a slow
 * integration — capping those at a minute quietly took a whole class of work
 * away from the offline pipeline, which shares every one of these abilities.
 * So the call passes the short one, and everything else gets the long one.
 */
export const LIVE_TOOL_DEADLINE_MS = 60_000

/** The offline ceiling: bounded so nothing wedges, long enough for real work. */
export const DEFAULT_TOOL_DEADLINE_MS = 15 * 60_000

/**
 * Identical failures of one tool before the run stops paying to find out again.
 *
 * Three is the point where "retry the flaky thing" becomes "this is down".
 * Every attempt past it buys a full step of context at full price and returns
 * the same sentence.
 */
export const TOOL_FAILURE_LIMIT = 3

/**
 * The most useful sentence available about a thrown value.
 *
 * `error.message` alone is not enough: a refused socket arrives as an
 * AggregateError whose own message is empty and whose detail sits in
 * `errors[]`, and wrapped failures hide theirs under `cause`. An empty string
 * reaches the agent as "that did not work" with no reason, which is how an
 * unreachable file store turns into eight blind retries of the same tool.
 */
function describeThrown(error: unknown): string {
  const seen = new Set<unknown>()
  const walk = (value: unknown): string => {
    if (value === null || value === undefined || seen.has(value)) return ''
    seen.add(value)
    if (!(value instanceof Error)) return String(value)
    const parts = [value.message.trim()]
    if (value instanceof AggregateError) {
      for (const inner of value.errors ?? []) parts.push(walk(inner))
    }
    parts.push(walk((value as { cause?: unknown }).cause))
    const detail = parts.filter(Boolean).join(': ')
    // Nameless and messageless still beats silence — say at least what it was.
    return detail || value.name || ''
  }
  return walk(error) || 'The tool failed without reporting a reason.'
}

/** Reject and propagate cancellation if the work has not settled by the deadline. */
async function withDeadline<T>(
  name: string,
  parent: AbortSignal | undefined,
  deadlineMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const abort = () => controller.abort(parent?.reason)
  if (parent?.aborted) abort()
  else parent?.addEventListener('abort', abort, { once: true })
  try {
    timer = setTimeout(() => {
      controller.abort(new Error(`${name} did not finish within ${Math.round(deadlineMs / 1000)} seconds.`))
    }, deadlineMs)
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        const rejectAbort = () => {
          reject(
            controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new DOMException('The operation was aborted.', 'AbortError'),
          )
        }
        if (controller.signal.aborted) rejectAbort()
        else controller.signal.addEventListener('abort', rejectAbort, { once: true })
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    parent?.removeEventListener('abort', abort)
    if (!controller.signal.aborted) controller.abort()
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
  /** How long one tool call may take. Short on a live call, generous offline. */
  deadlineMs?: number
  /** Cancels every in-flight tool when its run is cancelled or loses its lease. */
  signal?: AbortSignal
  /** Durable intent/outcome ledger for actions that have an autonomy category. */
  effects?: ExternalEffectGate
  /** Credentials held by this run. They may never cross a tool boundary. */
  secrets?: readonly string[]
}): ToolSet {
  const deadlineMs = args.deadlineMs ?? DEFAULT_TOOL_DEADLINE_MS
  const secrets = normalizeSecrets(args.secrets ?? [])
  // Same tool, same failure, over and over — one open breaker per run.
  const breakers = new Map<string, { failures: number; error: string }>()
  // Notify-level notices already written this run. Three parallel NetSuite
  // queries used to write the identical "Performed under notify-level
  // autonomy: Checking NetSuite" line three times per batch — noise that made
  // the ledger read like a stutter. The notice is a fact about the category
  // being exercised; once per distinct description is the whole of it.
  const notified = new Set<string>()
  const set: ToolSet = {}
  for (const ability of args.abilities) {
    const base = ability.tool
    if (!base.execute) {
      set[ability.name] = base as ToolSet[string]
      continue
    }
    const execute = base.execute.bind(base)
    set[ability.name] = {
      ...base,
      execute: async (input: unknown, options: unknown) => {
        // A credential in model-authored tool input is a leak in progress.
        // Refuse instead of replacing it and carrying out an action different
        // from the one an operator would read or approve.
        if (containsSecret(input, secrets)) {
          return {
            error: 'This action was blocked because it contained a protected credential.',
            note: 'Do not repeat, quote, save, or send the credential. Continue through the connected system without exposing its authentication material.',
          }
        }
        // An ungoverned ability — reading a page, a search, a calculation — has
        // no dial to consult, but it still has to come back. It used to skip
        // this wrapper entirely, so when one threw there was no result, no
        // error and nothing on the ledger: the activity showed as running for
        // ever, the caller was told "almost there" indefinitely, and the fault
        // was invisible to everyone. Governance is what the category decides;
        // finishing is not optional for anything.
        // Resolved per call, from the input, because for some abilities the
        // dial that applies depends on what is being asked for.
        const category = typeof ability.category === 'function' ? ability.category(input) : ability.category
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
          const notice = `Performed under notify-level autonomy (${category}): ${description}`
          if (!notified.has(notice)) {
            notified.add(notice)
            await args.sink.event({ kind: 'message', text: notice })
          }
        }
        // Every tool is bounded, and every tool comes back with something.
        // A throw used to escape here and be recorded nowhere: the loop only
        // ledgers successful results, so a page that 403'd left a tool_call
        // with no outcome — the activity read as running for ever, the caller
        // was told "almost there" indefinitely, and nothing anywhere said what
        // had happened. Failing is fine; failing invisibly is not.
        // A tool that has failed the same way three times is not flaky, it is
        // broken, and the next identical attempt costs another full step of
        // context at full price. One measured run spent roughly $24 of a
        // $26.70 report retrying a document tool whose file store was
        // unreachable; the input differed each time, so the no-progress
        // governor never saw a repeat. Refuse early and say so.
        const open = breakers.get(ability.name)
        if (open && open.failures >= TOOL_FAILURE_LIMIT) {
          return {
            error: open.error,
            note: `${ability.name} has already failed ${open.failures} times in this run with the same error, so it will not be tried again. Do not call it again. Report plainly that this step could not be completed and carry on with what you can still do.`,
          }
        }
        try {
          const optionRecord =
            typeof options === 'object' && options !== null ? (options as Record<string, unknown>) : {}
          const toolCallId =
            typeof optionRecord.toolCallId === 'string' && optionRecord.toolCallId
              ? optionRecord.toolCallId
              : `${ability.name}:${JSON.stringify(input)}`
          const invoke = (signal: AbortSignal) =>
            Promise.resolve(execute(input as any, { ...optionRecord, abortSignal: signal } as any))
          const result = await withDeadline(ability.name, args.signal, deadlineMs, (signal) =>
            category !== null && EXTERNAL_EFFECT_CATEGORIES.has(category) && args.effects
              ? args.effects.execute({
                  toolName: ability.name,
                  category,
                  idempotencyKey: toolCallId,
                  request: input,
                  signal,
                  operation: invoke,
                })
              : invoke(signal),
          )
          // Working again clears the count: a flaky endpoint is not a broken one.
          breakers.delete(ability.name)
          // Tool output becomes model input. Sanitize it before a connector can
          // echo its own authentication material into the model or transcript.
          return redactSecretValue(result, secrets)
        } catch (error) {
          // Cancellation is control flow for the whole run, not a recoverable
          // tool result. Returning it to the model let another step begin
          // after an operator pressed Stop even though the adapter itself had
          // correctly received the abort signal.
          if (args.signal?.aborted) throw error
          const message = redactSecrets(describeThrown(error), secrets)
          const prior = breakers.get(ability.name)
          const failures = prior && prior.error === message ? prior.failures + 1 : 1
          breakers.set(ability.name, { failures, error: message })
          const spent =
            failures >= TOOL_FAILURE_LIMIT
              ? ` It has now failed ${failures} times the same way and will not be tried again in this run.`
              : ''
          // Returned, not emitted: a returned value is a tool result like any
          // other and the loop ledgers it once. Recording it here as well wrote
          // every failure into the run's history twice, which double-counts
          // anything an operator or a report later tries to add up.
          return {
            error: message,
            note: `That did not work. Say so plainly and try another way.${spent}`,
          }
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
