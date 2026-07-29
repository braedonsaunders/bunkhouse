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

/** A tool still running after this long earns the caller a short filler line. */
const SLOW_TOOL_MS = 2500

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
  /**
   * Fired once per tool call, only if the tool is still running after
   * SLOW_TOOL_MS — the voice agent uses it to keep the caller company with a
   * short filler line. Never fires after the tool has settled.
   */
  onSlow?: (info: { toolName: string }) => void
  /**
   * Fired once per tool call when it settles — success, failure, forbidden, or
   * queued for approval — so the voice agent can make sure the conversation
   * resumes if the session went quiet while the tool ran.
   */
  onSettled?: (info: { toolName: string }) => void
}): Record<string, llm.FunctionTool> {
  const tools: Record<string, llm.FunctionTool> = {}
  // One request per distinct action, however many times the agent tries it.
  // A model told "queued for approval" often retries the identical call, and
  // a manager should find one decision to make, not a column of the same one.
  const filed = new Map<string, string>()
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
        // One filler timer per tool call: it fires once, and only while the
        // tool is genuinely still running — settling clears it first.
        const slowTimer = args.onSlow
          ? setTimeout(() => args.onSlow?.({ toolName: ability.name }), SLOW_TOOL_MS)
          : null
        const settle = () => {
          if (slowTimer) clearTimeout(slowTimer)
          args.onSettled?.({ toolName: ability.name })
        }
        try {
          if (ability.category !== null) {
            const level = args.autonomy(ability.category)
            if (level === 'forbidden') {
              const output = {
                status: 'forbidden',
                note: `The ${ability.category} ability is disabled for you. Tell the caller a colleague or a human has to do this, and offer to pass it on.`,
              }
              await args.record('tool_result', { toolName: ability.name, output }).catch(() => {})
              settle()
              return output
            }
            if (level === 'approval' && ability.approval !== 'continues') {
              const description = `${ability.name} with ${JSON.stringify(input)}`
              const already = filed.get(description)
              const approvalId = already ?? (await args.fileApproval({
                category: ability.category,
                description,
                action: { toolName: ability.name, input: input as Record<string, unknown> },
              })).approvalId
              if (!already) {
                filed.set(description, approvalId)
                await args
                  .record('approval_request', { approvalId, toolName: ability.name, category: ability.category, description })
                  .catch(() => {})
              }
              settle()
              return {
                status: 'pending_approval',
                approvalId,
                note: already
                  ? 'Still waiting on the same sign-off you already asked for — do not ask again. Tell the caller it is with their manager, and move on to something you can do.'
                  : 'This action needs human sign-off and has been queued. Tell the caller it is awaiting approval and will happen once signed off — then carry on with the call.',
              }
            }
          }
          const output = await execute(input as never, { toolCallId: randomUUID(), messages: [] } as never)
          await args.record('tool_result', { toolName: ability.name, output }).catch(() => {})
          settle()
          return output
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await args.record('tool_result', { toolName: ability.name, output: { error: message } }).catch(() => {})
          settle()
          return { error: message, note: 'Tell the caller this did not work, plainly, and offer an alternative.' }
        }
      },
    }) as unknown as llm.FunctionTool
  }
  return tools
}
