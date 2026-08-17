import { generateText, stepCountIs, type ModelMessage } from 'ai'
import { getModel } from '@appkit/ai'
import {
  citeProcedureAbility,
  governedToolSet,
  takeAbilityFrame,
  type Ability,
  type GovernanceState,
} from './abilities'
import { cachedInputTokens, cachedSystemMessage, sessionPinningOptions } from './caching'
import { compactMessages, COMPACT_KEEP_RECENT } from './compaction'
import { reportedCostUsd, usageAccountingOptions } from './cost'
import { buildRunInstruction, buildSystemPrompt } from './prompt'
import { loadSkillAbility, type BoundSkill } from './skills'
import { createRedactingSink, normalizeSecrets, redactSecrets, redactSecretValue } from './redaction'
import type {
  ApprovalGate,
  AutonomyResolver,
  BoundProcedure,
  BudgetMeter,
  CompanyProfile,
  AgentProfile,
  MemoryNote,
  RunInput,
  RunOutcome,
  RunSink,
  TokenUsage,
} from './types'

export type RunAgentArgs = {
  agent: AgentProfile
  company: CompanyProfile
  procedures: BoundProcedure[]
  memories: MemoryNote[]
  /** Skills this agent may draw on; indexed in the prompt, loaded on demand. */
  skills?: BoundSkill[]
  /** Writes a loaded skill's bundle into the agent's workspace. */
  materializeSkill?: (skill: BoundSkill) => Promise<{ path: string; files: string[] }>
  abilities: Ability[]
  input: RunInput
  autonomy: AutonomyResolver
  approvals: ApprovalGate
  budget: BudgetMeter
  sink: RunSink
  /** Resume context: prior messages from a suspended run being continued. */
  priorMessages?: ModelMessage[]
  maxSteps?: number
  /**
   * How long any one tool call may take. A live call passes a short one — the
   * caller is holding a phone; offline work gets the generous default, because
   * a build, a document, or a slow integration is not a wedged run.
   */
  toolDeadlineMs?: number
  abortSignal?: AbortSignal
  /**
   * The run this work belongs to. Used to pin every step of one run to the
   * same upstream so the prompt cache built on step one is still there on
   * step twelve.
   */
  runId?: string
  describeAction?: (toolName: string, input: unknown) => string
  /**
   * Shared governance state. Pass one in when app-side abilities need to
   * signal a suspension (ask-and-wait); the loop creates its own otherwise.
   */
  state?: GovernanceState
  /**
   * Asked between steps: has an operator stopped this run?
   *
   * Cancellation is cooperative rather than a kill, because a step is not
   * interruptible without deciding what to do with a tool call already in
   * flight — an email half sent, a document half written. Stopping at the
   * boundary means the run ends somewhere it can explain, and everything it
   * did before is kept. A step is the same granularity the budget governor
   * uses, and for the same reason.
   */
  isCancelled?: () => Promise<boolean>
  /** Additional credentials held by application adapters during this run. */
  runSecrets?: readonly string[]
}

/**
 * The runaway backstop — NOT a limit on how much work an agent may do.
 *
 * It used to be both, and at 24 steps (60 for an assignment) that made every
 * agent a sprinter: a person who researches for an afternoon, drafts, revises
 * and sends takes hundreds of steps, and the run was cut off long before with
 * the work half done and nothing saying why. An employee is not stopped after
 * sixty actions; they are stopped by the day ending or the money running out.
 *
 * So the real governors are the two below — the salary budget, now consulted
 * every step instead of once at the door, and no-progress detection — and this
 * is only what catches a loop neither of them would.
 */
const DEFAULT_MAX_STEPS = 200

/**
 * The same tool, called with the same input, this many times in a row.
 *
 * The honest replacement for a low step cap. A cap stops a runaway loop by
 * stopping everything, including the run that was working; this stops only the
 * run that has genuinely stopped getting anywhere. Repeating a call is not by
 * itself wrong — retrying a flaky fetch is exactly right — so the threshold is
 * where retrying stops being retrying.
 */
const NO_PROGRESS_REPEATS = 6

/**
 * Input tokens in a single step, past which something has gone wrong rather
 * than gone long.
 *
 * A run was measured at 128,000 input tokens per model call on average, with
 * one call at 1,025,158, while a colleague doing comparable work sat at 10,000
 * — the difference being a transcript, screenshots and a back catalogue of
 * notes all being re-read at full price every step. The budget stops that
 * eventually, but only after paying for it; a step this size is worth stopping
 * on its own, because whatever comes after it will be larger still and no
 * larger context was ever the thing that was missing.
 */
const MAX_STEP_INPUT_TOKENS = 500_000

/**
 * One complete unit of an agent's work, headless. The loop enforces what prompts
 * cannot: the autonomy dial (via governed tools), the salary budget (checked
 * before starting and per step), and the append-only event record. A gated
 * action suspends the run with 'waiting_approval'; the caller resumes it later
 * with priorMessages + the approved tool result.
 */
export async function runAgent(args: RunAgentArgs): Promise<RunOutcome> {
  const providerKey = typeof args.agent.ai.apiKey === 'string' ? args.agent.ai.apiKey : ''
  const runSecrets = normalizeSecrets([providerKey, ...(args.runSecrets ?? [])])
  const sink = createRedactingSink(args.sink, runSecrets)
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }

  const remaining = await args.budget.remainingUsd()
  if (remaining <= 0 && args.budget.overagePolicy === 'pause') {
    await sink.event({
      kind: 'error',
      message: 'Salary budget exhausted and overage policy is pause; run not started.',
    })
    return {
      status: 'budget_paused',
      usage,
      messages: redactSecretValue(args.priorMessages ?? [], runSecrets),
    }
  }

  const model = getModel(args.agent.ai, 'smart')
  if (!model) {
    const message = `No model available for ${args.agent.name} (provider ${args.agent.ai.provider}).`
    await sink.event({ kind: 'error', message })
    return {
      status: 'failed',
      error: redactSecrets(message, runSecrets),
      usage,
      messages: redactSecretValue(args.priorMessages ?? [], runSecrets),
    }
  }

  const state: GovernanceState = args.state ?? { pendingApprovalId: null, pendingWait: null }
  const skills = args.skills ?? []
  const abilities = [
    ...args.abilities,
    citeProcedureAbility({ sink, procedures: args.procedures }),
    // Offered only when the agent actually has skills, so an agent with none
    // is never told about a tool that can only answer "you have no skills".
    ...(skills.length > 0
      ? [
          loadSkillAbility({
            sink,
            skills,
            ...(args.materializeSkill ? { materialize: args.materializeSkill } : {}),
          }),
        ]
      : []),
  ]
  const tools = governedToolSet({
    abilities,
    autonomy: args.autonomy,
    approvals: args.approvals,
    sink,
    state,
    describeAction: args.describeAction,
    ...(args.toolDeadlineMs ? { deadlineMs: args.toolDeadlineMs } : {}),
    secrets: runSecrets,
  })

  const system = buildSystemPrompt({
    agent: args.agent,
    company: args.company,
    procedures: args.procedures,
    memories: args.memories,
    skills,
  })
  // Image attachments ride the opening turn so multimodal models genuinely
  // see what was sent — a photo of a receipt is content, not a filename.
  const images = args.input.type === 'email' ? (args.input.images ?? []) : []
  const instruction = buildRunInstruction(args.input)
  const messages: ModelMessage[] = [
    ...redactSecretValue(args.priorMessages ?? [], runSecrets),
    {
      role: 'user',
      content:
        images.length === 0
          ? instruction
          : [
              { type: 'text' as const, text: instruction },
              ...images.map((img) => ({
                type: 'image' as const,
                image: img.dataBase64,
                mediaType: img.mediaType,
              })),
            ],
    },
  ]

  // Where the provider is willing to price its own work, ask it to. The flag
  // costs nothing and makes the ledger authoritative rather than estimated.
  // Pinned to one upstream in the same breath, so the steps of this run keep
  // meeting the same prompt cache instead of scattering across providers.
  const accounting = usageAccountingOptions(args.agent.ai)
  const pinning = sessionPinningOptions(args.agent.ai, args.runId)
  const providerOptions =
    accounting || pinning
      ? Object.fromEntries(
          [...new Set([...Object.keys(accounting ?? {}), ...Object.keys(pinning ?? {})])].map((name) => [
            name,
            { ...(accounting?.[name] ?? {}), ...(pinning?.[name] ?? {}) },
          ]),
        )
      : undefined

  // A provider that needs to be told where the reusable prefix ends gets the
  // system prompt as a marked message; one that caches by itself keeps the
  // plain string, which is what it would have had anyway.
  const cachedSystem = cachedSystemMessage(args.agent.ai, system)
  if (cachedSystem) messages.unshift(cachedSystem)

  // What lets a run go long: something watching the money, and something that
  // can tell work from a loop. Both are read by `stopWhen` after every step.
  let budgetExhausted = false
  let cancelled = false
  let stuck = false
  let bloated = false
  let lastCall: string | null = null
  let repeats = 0
  let compactionAnnounced = false

  try {
    const result = await generateText({
      model,
      system,
      messages,
      tools,
      temperature: args.agent.temperature,
      ...(providerOptions ? { providerOptions } : {}),
      stopWhen: [
        stepCountIs(args.maxSteps ?? DEFAULT_MAX_STEPS),
        () => state.pendingApprovalId !== null || state.pendingWait !== null,
        // The two governors that let a run go long safely.
        () => budgetExhausted || cancelled || stuck || bloated,
      ],
      // Evidence the agent has already reasoned over does not need re-buying at
      // full price on every subsequent step. The working set stays verbatim.
      prepareStep: async ({ messages: stepMessages }) => {
        const { messages: compacted, trimmedChars, trimmedResults } = compactMessages(stepMessages)
        if (trimmedChars <= 0) return {}
        if (!compactionAnnounced) {
          compactionAnnounced = true
          await sink.event({
            kind: 'message',
            text: `Trimmed ${trimmedResults} earlier tool result(s) from the working context to keep this run affordable. The most recent ${COMPACT_KEEP_RECENT} are unchanged.`,
          })
        }
        return { messages: compacted }
      },
      abortSignal: args.abortSignal,
      onStepFinish: async (step) => {
        usage.inputTokens += step.usage.inputTokens ?? 0
        usage.outputTokens += step.usage.outputTokens ?? 0
        const cached = cachedInputTokens(step.usage)
        if (cached > 0) usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + cached
        for (const call of step.toolCalls) {
          // Going round in circles: the same call, with the same input, over
          // and over. A run allowed to work for hours needs something that can
          // tell working from spinning, because a step ceiling low enough to
          // catch the spinning also cut off the working.
          const signature = `${call.toolName}:${JSON.stringify(call.input)}`
          repeats = signature === lastCall ? repeats + 1 : 1
          lastCall = signature
          if (repeats >= NO_PROGRESS_REPEATS && !stuck) {
            stuck = true
            await sink.event({
              kind: 'error',
              message: `Stopped: ${call.toolName} was called ${repeats} times with the same input and nothing changed. Whatever this run was trying is not going to work this way.`,
            })
          }
          const ability = abilities.find((a) => a.name === call.toolName)
          await sink.event({
            kind: 'tool_call',
            toolName: call.toolName,
            // Same resolution the governed wrapper used, so the ledger records
            // the dial that actually applied rather than the ability's label.
            category:
              typeof ability?.category === 'function' ? ability.category(call.input) : (ability?.category ?? null),
            input: call.input,
          })
        }
        for (const toolResult of step.toolResults) {
          // A frame the ability handed the model is already filed as evidence
          // by the ability itself; the ledger keeps what happened, not a
          // second copy of the bytes.
          const { rest } = takeAbilityFrame(toolResult.output)
          await sink.event({
            kind: 'tool_result',
            toolName: toolResult.toolName,
            output: rest,
          })
        }
        if (step.text) await sink.event({ kind: 'message', text: step.text })
        // What the provider says the step cost, where it says anything. Null
        // means it did not, and the sink prices the tokens itself.
        const reported = providerOptions ? reportedCostUsd(step.response.body) : null
        await sink.spend({
          provider: args.agent.ai.provider,
          model: args.agent.ai.modelSmart ?? '',
          inputTokens: step.usage.inputTokens ?? 0,
          outputTokens: step.usage.outputTokens ?? 0,
          ...(cached > 0 ? { cachedInputTokens: cached } : {}),
          ...(reported === null ? {} : { costUsd: reported }),
        })
        // The budget, every step — not once at the door. Checking it only at
        // the start was survivable while a run was two dozen steps long; it is
        // not what governs a run that may legitimately work for hours, and it
        // is the whole reason a long run can be allowed at all.
        const stepInput = step.usage.inputTokens ?? 0
        if (stepInput > MAX_STEP_INPUT_TOKENS && !bloated) {
          bloated = true
          await sink.event({
            kind: 'error',
            message: `Stopped: one step sent ${stepInput.toLocaleString()} input tokens, past the ${MAX_STEP_INPUT_TOKENS.toLocaleString()} ceiling. The context is carrying far more than this work needs, and every further step would cost more than the last.`,
          })
        }
        // Asked once per step, like the budget below it. An operator who
        // stops a run wants it stopped now, not at whatever natural end it
        // would otherwise reach — which for a long run may be hours away.
        if (!cancelled && args.isCancelled && (await args.isCancelled().catch(() => false))) {
          cancelled = true
          await sink.event({
            kind: 'message',
            text: 'Stopped by an operator. Ending here; everything done up to this point is kept.',
          })
        }
        if (!budgetExhausted && args.budget.overagePolicy === 'pause') {
          const left = await args.budget.remainingUsd().catch(() => 1)
          if (left <= 0) {
            budgetExhausted = true
            await sink.event({
              kind: 'message',
              text: 'Stopping here: the salary budget for this agent is spent.',
            })
          }
        }
      },
    })

    const transcript = redactSecretValue<ModelMessage[]>(
      [...messages, ...result.response.messages],
      runSecrets,
    )
    // Out of money is not a failure and not a success: the work that was done
    // is kept, and the outcome says plainly why it stopped where it did.
    if (budgetExhausted) return { status: 'budget_paused', usage, messages: transcript }
    // Ahead of the suspensions: a run an operator stopped must not come back
    // as one waiting on them for something.
    if (cancelled) return { status: 'cancelled', usage, messages: transcript }
    if (state.pendingApprovalId) {
      return { status: 'waiting_approval', approvalId: state.pendingApprovalId, usage, messages: transcript }
    }
    if (state.pendingWait) {
      return { status: 'waiting_reply', wait: state.pendingWait, usage, messages: transcript }
    }
    return {
      status: 'completed',
      summary: redactSecrets(result.text, runSecrets),
      usage,
      messages: transcript,
    }
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error), runSecrets)
    await sink.event({ kind: 'error', message })
    return {
      status: 'failed',
      error: message,
      usage,
      messages: redactSecretValue(messages, runSecrets),
    }
  }
}
