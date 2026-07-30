import { generateText, stepCountIs, type ModelMessage } from 'ai'
import { getModel } from '@appkit/ai'
import {
  citeProcedureAbility,
  governedToolSet,
  takeAbilityFrame,
  type Ability,
  type GovernanceState,
} from './abilities'
import { reportedCostUsd, usageAccountingOptions } from './cost'
import { buildRunInstruction, buildSystemPrompt } from './prompt'
import { loadSkillAbility, type BoundSkill } from './skills'
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
  describeAction?: (toolName: string, input: unknown) => string
  /**
   * Shared governance state. Pass one in when app-side abilities need to
   * signal a suspension (ask-and-wait); the loop creates its own otherwise.
   */
  state?: GovernanceState
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
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }

  const remaining = await args.budget.remainingUsd()
  if (remaining <= 0 && args.budget.overagePolicy === 'pause') {
    await args.sink.event({
      kind: 'error',
      message: 'Salary budget exhausted and overage policy is pause; run not started.',
    })
    return { status: 'budget_paused', usage, messages: args.priorMessages ?? [] }
  }

  const model = getModel(args.agent.ai, 'smart')
  if (!model) {
    const message = `No model available for ${args.agent.name} (provider ${args.agent.ai.provider}).`
    await args.sink.event({ kind: 'error', message })
    return { status: 'failed', error: message, usage, messages: args.priorMessages ?? [] }
  }

  const state: GovernanceState = args.state ?? { pendingApprovalId: null, pendingWait: null }
  const skills = args.skills ?? []
  const abilities = [
    ...args.abilities,
    citeProcedureAbility({ sink: args.sink, procedures: args.procedures }),
    // Offered only when the agent actually has skills, so an agent with none
    // is never told about a tool that can only answer "you have no skills".
    ...(skills.length > 0
      ? [
          loadSkillAbility({
            sink: args.sink,
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
    sink: args.sink,
    state,
    describeAction: args.describeAction,
    ...(args.toolDeadlineMs ? { deadlineMs: args.toolDeadlineMs } : {}),
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
    ...(args.priorMessages ?? []),
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
  const providerOptions = usageAccountingOptions(args.agent.ai)

  // What lets a run go long: something watching the money, and something that
  // can tell work from a loop. Both are read by `stopWhen` after every step.
  let budgetExhausted = false
  let stuck = false
  let bloated = false
  let lastCall: string | null = null
  let repeats = 0

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
        () => budgetExhausted || stuck || bloated,
      ],
      abortSignal: args.abortSignal,
      onStepFinish: async (step) => {
        usage.inputTokens += step.usage.inputTokens ?? 0
        usage.outputTokens += step.usage.outputTokens ?? 0
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
            await args.sink.event({
              kind: 'error',
              message: `Stopped: ${call.toolName} was called ${repeats} times with the same input and nothing changed. Whatever this run was trying is not going to work this way.`,
            })
          }
          const ability = abilities.find((a) => a.name === call.toolName)
          await args.sink.event({
            kind: 'tool_call',
            toolName: call.toolName,
            category: ability?.category ?? null,
            input: call.input,
          })
        }
        for (const toolResult of step.toolResults) {
          // A frame the ability handed the model is already filed as evidence
          // by the ability itself; the ledger keeps what happened, not a
          // second copy of the bytes.
          const { rest } = takeAbilityFrame(toolResult.output)
          await args.sink.event({
            kind: 'tool_result',
            toolName: toolResult.toolName,
            output: rest,
          })
        }
        if (step.text) await args.sink.event({ kind: 'message', text: step.text })
        // What the provider says the step cost, where it says anything. Null
        // means it did not, and the sink prices the tokens itself.
        const reported = providerOptions ? reportedCostUsd(step.response.body) : null
        await args.sink.spend({
          provider: args.agent.ai.provider,
          model: args.agent.ai.modelSmart ?? '',
          inputTokens: step.usage.inputTokens ?? 0,
          outputTokens: step.usage.outputTokens ?? 0,
          ...(reported === null ? {} : { costUsd: reported }),
        })
        // The budget, every step — not once at the door. Checking it only at
        // the start was survivable while a run was two dozen steps long; it is
        // not what governs a run that may legitimately work for hours, and it
        // is the whole reason a long run can be allowed at all.
        const stepInput = step.usage.inputTokens ?? 0
        if (stepInput > MAX_STEP_INPUT_TOKENS && !bloated) {
          bloated = true
          await args.sink.event({
            kind: 'error',
            message: `Stopped: one step sent ${stepInput.toLocaleString()} input tokens, past the ${MAX_STEP_INPUT_TOKENS.toLocaleString()} ceiling. The context is carrying far more than this work needs, and every further step would cost more than the last.`,
          })
        }
        if (!budgetExhausted && args.budget.overagePolicy === 'pause') {
          const left = await args.budget.remainingUsd().catch(() => 1)
          if (left <= 0) {
            budgetExhausted = true
            await args.sink.event({
              kind: 'message',
              text: 'Stopping here: the salary budget for this agent is spent.',
            })
          }
        }
      },
    })

    const transcript: ModelMessage[] = [...messages, ...result.response.messages]
    // Out of money is not a failure and not a success: the work that was done
    // is kept, and the outcome says plainly why it stopped where it did.
    if (budgetExhausted) return { status: 'budget_paused', usage, messages: transcript }
    if (state.pendingApprovalId) {
      return { status: 'waiting_approval', approvalId: state.pendingApprovalId, usage, messages: transcript }
    }
    if (state.pendingWait) {
      return { status: 'waiting_reply', wait: state.pendingWait, usage, messages: transcript }
    }
    return { status: 'completed', summary: result.text, usage, messages: transcript }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await args.sink.event({ kind: 'error', message })
    return { status: 'failed', error: message, usage, messages }
  }
}
