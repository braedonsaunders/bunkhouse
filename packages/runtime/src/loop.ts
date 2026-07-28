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
  /**
   * Shared governance state. Pass one in when app-side abilities need to
   * signal a suspension (ask-and-wait); the loop creates its own otherwise.
   */
  state?: GovernanceState
}

const DEFAULT_MAX_STEPS = 24

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
    agent: args.agent,
    company: args.company,
    procedures: args.procedures,
    memories: args.memories,
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

  try {
    const result = await generateText({
      model,
      system,
      messages,
      tools,
      temperature: args.agent.temperature,
      stopWhen: [
        stepCountIs(args.maxSteps ?? DEFAULT_MAX_STEPS),
        () => state.pendingApprovalId !== null || state.pendingWait !== null,
      ],
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
          provider: args.agent.ai.provider,
          model: args.agent.ai.modelSmart ?? '',
          inputTokens: step.usage.inputTokens ?? 0,
          outputTokens: step.usage.outputTokens ?? 0,
        })
      },
    })

    const transcript: ModelMessage[] = [...messages, ...result.response.messages]
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
