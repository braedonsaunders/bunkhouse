import { generateText, stepCountIs, type ModelMessage } from 'ai'
import { getModel } from '@appkit/ai'
import { citeProcedureAbility, governedToolSet, type Ability, type GovernanceState } from './abilities'
import { buildRunInstruction, buildSystemPrompt } from './prompt'
import type {
  ApprovalGate,
  AutonomyResolver,
  BoundProcedure,
  BudgetMeter,
  CompanyProfile,
  HandProfile,
  MemoryNote,
  RunInput,
  RunOutcome,
  RunSink,
  TokenUsage,
} from './types'

export type RunHandArgs = {
  hand: HandProfile
  company: CompanyProfile
  procedures: BoundProcedure[]
  memories: MemoryNote[]
  abilities: Ability[]
  input: RunInput
  autonomy: AutonomyResolver
  approvals: ApprovalGate
  budget: BudgetMeter
  sink: RunSink
  /** Resume context: prior messages from a suspended run being continued. */
  priorMessages?: ModelMessage[]
  maxSteps?: number
  abortSignal?: AbortSignal
  describeAction?: (toolName: string, input: unknown) => string
}

const DEFAULT_MAX_STEPS = 24

/**
 * One complete unit of a hand's work, headless. The loop enforces what prompts
 * cannot: the autonomy dial (via governed tools), the salary budget (checked
 * before starting and per step), and the append-only event record. A gated
 * action suspends the run with 'waiting_approval'; the caller resumes it later
 * with priorMessages + the approved tool result.
 */
export async function runHand(args: RunHandArgs): Promise<RunOutcome> {
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }

  const remaining = await args.budget.remainingUsd()
  if (remaining <= 0 && args.budget.overagePolicy === 'pause') {
    await args.sink.event({
      kind: 'error',
      message: 'Salary budget exhausted and overage policy is pause; run not started.',
    })
    return { status: 'budget_paused', usage }
  }

  const model = getModel(args.hand.ai, 'smart')
  if (!model) {
    const message = `No model available for ${args.hand.name} (provider ${args.hand.ai.provider}).`
    await args.sink.event({ kind: 'error', message })
    return { status: 'failed', error: message, usage }
  }

  const state: GovernanceState = { pendingApprovalId: null }
  const abilities = [...args.abilities, citeProcedureAbility({ sink: args.sink, procedures: args.procedures })]
  const tools = governedToolSet({
    abilities,
    autonomy: args.autonomy,
    approvals: args.approvals,
    sink: args.sink,
    state,
    describeAction: args.describeAction,
  })

  const system = buildSystemPrompt({
    hand: args.hand,
    company: args.company,
    procedures: args.procedures,
    memories: args.memories,
  })
  const messages: ModelMessage[] = [
    ...(args.priorMessages ?? []),
    { role: 'user', content: buildRunInstruction(args.input) },
  ]

  try {
    const result = await generateText({
      model,
      system,
      messages,
      tools,
      temperature: args.hand.temperature,
      stopWhen: [stepCountIs(args.maxSteps ?? DEFAULT_MAX_STEPS), () => state.pendingApprovalId !== null],
      abortSignal: args.abortSignal,
      onStepFinish: async (step) => {
        usage.inputTokens += step.usage.inputTokens ?? 0
        usage.outputTokens += step.usage.outputTokens ?? 0
        for (const call of step.toolCalls) {
          const ability = abilities.find((a) => a.name === call.toolName)
          await args.sink.event({
            kind: 'tool_call',
            toolName: call.toolName,
            category: ability?.category ?? null,
            input: call.input,
          })
        }
        for (const toolResult of step.toolResults) {
          await args.sink.event({
            kind: 'tool_result',
            toolName: toolResult.toolName,
            output: toolResult.output,
          })
        }
        if (step.text) await args.sink.event({ kind: 'message', text: step.text })
        await args.sink.spend({
          provider: args.hand.ai.provider,
          model: args.hand.ai.modelSmart ?? '',
          inputTokens: step.usage.inputTokens ?? 0,
          outputTokens: step.usage.outputTokens ?? 0,
        })
      },
    })

    if (state.pendingApprovalId) {
      return { status: 'waiting_approval', approvalId: state.pendingApprovalId, usage }
    }
    return { status: 'completed', summary: result.text, usage }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await args.sink.event({ kind: 'error', message })
    return { status: 'failed', error: message, usage }
  }
}
