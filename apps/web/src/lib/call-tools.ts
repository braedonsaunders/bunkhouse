import { randomUUID } from 'node:crypto'
import { llm } from '@livekit/agents'
import type { Ability, ActionCategory, AutonomyLevel } from '@bunkhouse/runtime'

/**
 * The bridge between the runtime's abilities and a live voice session: each
 * ability becomes a LiveKit function tool, wrapped in the same autonomy-dial
 * governance email runs get. Only the approval posture differs — a run
 * suspends until sign-off, but a call cannot hold the line for a manager, so
 * the request is filed, the agent says so, and the conversation continues.
 *
 * Imported only by the voice agent process; the web app never bundles this.
 */
export function governedCallTools(args: {
  abilities: Ability[]
  autonomy: (category: ActionCategory) => AutonomyLevel
  fileApproval: (input: {
    category: ActionCategory
    description: string
    action: Record<string, unknown>
  }) => Promise<{ approvalId: string }>
  /** Append a run event — the call's audit trail matches an email run's. */
  record: (kind: 'tool_call' | 'tool_result' | 'approval_request', payload: Record<string, unknown>) => Promise<void>
}): Record<string, llm.FunctionTool> {
  const tools: Record<string, llm.FunctionTool> = {}
  for (const ability of args.abilities) {
    const base = ability.tool
    if (!base.execute) continue
    const execute = base.execute.bind(base)
    // The ability's zod schema is type-erased (the runtime treats tools
    // opaquely), so the LiveKit generic cannot infer arguments here — the
    // schema is still passed through whole and validated at call time.
    // Anonymous by design: entries in a tool map take their name from the key.
    tools[ability.name] = llm.tool({
      description: base.description ?? ability.name,
      parameters: base.inputSchema as unknown as Parameters<typeof llm.tool>[0]['parameters'],
      // Deliberately NOT ToolFlag.CANCELLABLE: when the caller barges in, the
      // agent's speech stops but work in flight — a search, an email, an
      // integration write — keeps running and reports back on the next turn.
      // Interrupting a person mid-lookup does not make them drop the lookup.
      flags: llm.ToolFlag.NONE,
      execute: async (input: unknown) => {
        await args
          .record('tool_call', { toolName: ability.name, category: ability.category, input })
          .catch(() => {})
        try {
          if (ability.category !== null) {
            const level = args.autonomy(ability.category)
            if (level === 'forbidden') {
              return {
                status: 'forbidden',
                note: `The ${ability.category} ability is disabled for you. Tell the caller a colleague or a human has to do this, and offer to pass it on.`,
              }
            }
            if (level === 'approval') {
              const description = `${ability.name} with ${JSON.stringify(input)}`
              const { approvalId } = await args.fileApproval({
                category: ability.category,
                description,
                action: { toolName: ability.name, input: input as Record<string, unknown> },
              })
              await args
                .record('approval_request', { approvalId, category: ability.category, description })
                .catch(() => {})
              return {
                status: 'pending_approval',
                approvalId,
                note: 'This action needs human sign-off and has been queued. Tell the caller it is awaiting approval and will happen once signed off — then carry on with the call.',
              }
            }
          }
          const output = await execute(input as never, { toolCallId: randomUUID(), messages: [] } as never)
          await args.record('tool_result', { toolName: ability.name, output }).catch(() => {})
          return output
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await args.record('tool_result', { toolName: ability.name, output: { error: message } }).catch(() => {})
          return { error: message, note: 'Tell the caller this did not work, plainly, and offer an alternative.' }
        }
      },
    }) as unknown as llm.FunctionTool
  }
  return tools
}
