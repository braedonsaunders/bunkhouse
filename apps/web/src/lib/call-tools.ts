import { randomUUID } from 'node:crypto'
import { llm } from '@livekit/agents'
import { z } from 'zod'
import type { Ability, ActionCategory, AutonomyLevel } from '@bunkhouse/runtime'
import { describeToolCall } from './call-activity'
import { describeError, type CallWorker, type WorkReport } from './call-worker'

/**
 * What the talker can reach for while it is on the line.
 *
 * Six tools, not twenty-nine. The talker owns the conversation — hearing,
 * prosody, turn-taking, barge-in — and a speech-to-speech model picks badly
 * from a large surface, so the surface is deliberately tiny and everything on
 * it is genuinely part of talking. The agent's actual working kit runs beside
 * the call: `do_work` hands over an intent and comes back in milliseconds,
 * and the work narrates itself into the conversation while the agent talks.
 *
 * Two of these six are the same capability with different timing. `do_work`
 * is the live disposition — the caller is waiting, the answer is spoken on the
 * call. `take_assignment` is the deferred one — the work outlives the call and
 * arrives by email. Same engine, same governance underneath both.
 *
 * `do_work` is the framework's own async tool: the first `ctx.update()`
 * answers the model, marks the call non-blocking, and lets the session carry
 * on; every later update is inserted into the chat context and delivered as a
 * fresh turn only once the session is idle, so progress never talks over the
 * caller or over the agent itself. The tool's eventual return value arrives the
 * same way, as the result the agent reads out. There is no filler timer.
 *
 * Imported only by the voice agent process; the web app never bundles this.
 */

/** How the agent should hear about the work it just handed over. */
const HANDED_OVER =
  'You have this in hand and it is running now. Carry on talking to the caller — say in a few natural words that you are on it, and never claim a result you have not been told.'

/** One line per piece of work, for `check_work` and for the model to read. */
function readable(report: WorkReport): Record<string, unknown> {
  return {
    handle: report.id,
    askedFor: report.intent,
    state:
      report.status === 'working'
        ? 'still running'
        : report.status === 'done'
          ? 'finished'
          : report.status === 'needs_approval'
            ? 'waiting on a human decision'
            : report.status === 'stopped'
              ? 'stopped when the call ended'
              : 'could not be done',
    latest: report.detail,
    runningForSeconds: report.runningForSeconds,
  }
}

/**
 * The autonomy dial, and the one gate an approval is filed through. Identical
 * to what the governed loop uses on the work side — the talker's two abilities
 * are governed by the same rules, filed against the same run, and deduplicated
 * by the same record check.
 */
export type CallGovernance = {
  autonomy: (category: ActionCategory) => AutonomyLevel
  fileApproval: (input: {
    category: ActionCategory
    description: string
    action: Record<string, unknown>
  }) => Promise<{ approvalId: string; alreadyRequested: boolean }>
}

/** Hand one of the agent's own abilities straight to the talker, governed. */
function surfacedAbility(args: {
  ability: Ability
  governance: CallGovernance
  record: (kind: 'tool_call' | 'tool_result' | 'approval_request', payload: Record<string, unknown>) => Promise<void>
}): llm.FunctionTool {
  const { ability, governance } = args
  const base = ability.tool
  const execute = base.execute!.bind(base)
  return llm.tool({
    description: base.description ?? ability.name,
    // The ability's zod schema is type-erased (the runtime treats tools
    // opaquely), so the LiveKit generic cannot infer arguments here — the
    // schema is still passed through whole and validated at call time.
    parameters: base.inputSchema as unknown as Parameters<typeof llm.tool>[0]['parameters'],
    // Deliberately NOT ToolFlag.CANCELLABLE: both of these settle in
    // milliseconds, and marking anything cancellable would put the framework's
    // own task-listing and cancel tools on the line beside them.
    flags: llm.ToolFlag.NONE,
    execute: async (input: unknown) => {
      await args.record('tool_call', { toolName: ability.name, category: ability.category, input }).catch(() => {})
      try {
        if (ability.category !== null) {
          const level = governance.autonomy(ability.category)
          if (level === 'forbidden') {
            const output = {
              status: 'forbidden',
              note: `The ${ability.category} ability is disabled for you. Tell the caller a colleague or a human has to do this, and offer to pass it on.`,
            }
            await args.record('tool_result', { toolName: ability.name, output }).catch(() => {})
            return output
          }
          if (level === 'approval' && ability.approval !== 'continues') {
            const description = describeToolCall(ability.name, input)
            const { approvalId, alreadyRequested } = await governance.fileApproval({
              category: ability.category,
              description,
              action: { toolName: ability.name, input: input as Record<string, unknown> },
            })
            if (!alreadyRequested) {
              await args
                .record('approval_request', {
                  approvalId,
                  toolName: ability.name,
                  category: ability.category,
                  description,
                })
                .catch(() => {})
            }
            const output = {
              status: 'pending_approval',
              approvalId,
              note: alreadyRequested
                ? 'Still waiting on the same sign-off you already asked for — do not ask again. Tell the caller it is with their manager, and move on.'
                : 'This needs human sign-off and has been queued. Tell the caller it is awaiting approval and will happen once signed off — then carry on with the call.',
            }
            await args.record('tool_result', { toolName: ability.name, output }).catch(() => {})
            return output
          }
        }
        const output = await execute(input as never, { toolCallId: randomUUID(), messages: [] } as never)
        await args.record('tool_result', { toolName: ability.name, output }).catch(() => {})
        return output
      } catch (error) {
        const message = describeError(error)
        await args.record('tool_result', { toolName: ability.name, output: { error: message } }).catch(() => {})
        return { error: message, note: 'Tell the caller this did not work, plainly, and offer an alternative.' }
      }
    },
  }) as unknown as llm.FunctionTool
}

export function callTools(args: {
  /** The worker this call hands its work to. */
  worker: CallWorker
  /**
   * The agent's assembled ability set. Two of them are genuinely part of
   * talking and are surfaced by name; the rest belong to the worker and the
   * talker never sees them.
   */
  abilities: Ability[]
  /** The dial and the approval gate the surfaced abilities are governed by. */
  governance: CallGovernance
  /** Append a run event — the call's audit trail matches an email run's. */
  record: (kind: 'tool_call' | 'tool_result' | 'approval_request', payload: Record<string, unknown>) => Promise<void>
  /**
   * Put the receiver down. Returns at once so the agent can finish its last
   * words; the hangup itself drains that speech before closing the room.
   */
  hangUp: (reason: string) => void
  /**
   * Hand the line to a human, where there is a line to hand over. Null on a
   * browser call or a video meeting — there is no SIP leg to refer.
   */
  transfer:
    | ((input: { extension: string; reason: string }) => Promise<{ transferred: boolean; reason?: string }>)
    | null
  /** Operator-facing log line for anything that goes wrong along the way. */
  onError: (message: string) => void
}): Record<string, llm.FunctionTool> {
  const { worker } = args
  const tools: Record<string, llm.FunctionTool> = {}

  tools.do_work = llm.tool({
    description:
      'Do something the caller is waiting on, while you keep talking. Describe it in plain language, exactly as you would ask a capable colleague — "find the three nearest suppliers of galvanised pipe and what they charge", "check whether we are open on the Monday holiday and email Dana the answer". This is how work gets done on a call: searching, reading pages, driving a browser, writing documents, sending email, running things in your workspace, and every system connected to you. It comes straight back with the work already running, and tells you what is happening as it happens. For work the caller is NOT waiting on — anything that outlives this call, or that they asked you to send on afterwards — use take_assignment instead.',
    parameters: z.object({
      intent: z
        .string()
        .describe(
          'What needs doing, in plain language, with every detail the caller gave — names, numbers, dates, addresses, what a good answer looks like.',
        ),
    }),
    // Deliberately NOT ToolFlag.CANCELLABLE: barge-in stops the agent's
    // speech, not its work — interrupting a person mid-lookup does not make
    // them drop the lookup — and cancellable tools put the framework's task
    // listing and cancel tools on the line beside these six.
    flags: llm.ToolFlag.NONE,
    execute: async ({ intent }, { ctx, abortSignal }) => {
      // Every update copies the chat context, inserts into it, and writes it
      // back, so two landing at once would lose one: they go through in a
      // chain. Nothing here is awaited by the session — the chain runs beside
      // the conversation, and the framework holds each line until nobody is
      // talking before it is spoken.
      let narration: Promise<void> = Promise.resolve()
      const work = worker.startWork(intent, {
        onProgress: (line) => {
          narration = narration
            .then(() => ctx.update(line))
            .catch((error: unknown) => args.onError(`a progress line was not delivered: ${describeError(error)}`))
        },
      })
      // Head of the chain, assigned before any await so no progress line can
      // get in front of it: this first update is what answers the model, in
      // milliseconds, and turns the call non-blocking.
      narration = ctx.update(`Working on it now, under the handle ${work.id}. ${HANDED_OVER}`)
      await narration
      // The signal fires when the session is being torn down. Stop waiting
      // then — the call's own teardown stops the work itself.
      const settled = await Promise.race([
        work.settled,
        new Promise<null>((resolve) => {
          if (abortSignal.aborted) resolve(null)
          else abortSignal.addEventListener('abort', () => resolve(null), { once: true })
        }),
      ])
      // Nothing to deliver: the line is gone, and returning nothing is how the
      // framework is told there is no deferred reply to make.
      if (!settled) return null
      return readable(settled)
    },
  }) as unknown as llm.FunctionTool

  tools.check_work = llm.tool({
    description:
      'See where everything you have handed over has got to — what is still running, what finished, and what is waiting on a human. Use it when the caller asks how it is going, or when you want to be sure before you speak.',
    parameters: z.object({}),
    flags: llm.ToolFlag.NONE,
    execute: async () => {
      const work = worker.checkWork()
      if (work.length === 0) {
        return { work: [], note: 'Nothing is running. If the caller has asked for something, hand it over with do_work.' }
      }
      return { work: work.map(readable) }
    },
  }) as unknown as llm.FunctionTool

  // Hanging up is the agent's to do when the goodbye is genuinely said — the
  // receiver going down, not a timeout. The tool returns immediately so the
  // model can finish its last words; the hangup waits for that speech to play
  // out, settles the ledger, and then takes the room down, which is what
  // actually ends the call for the caller.
  tools.end_call = llm.tool({
    description:
      'Hang up the call. Use only when the conversation has reached its natural end — the work is agreed or done and goodbyes have been said. Never to cut someone off.',
    parameters: z.object({
      reason: z.string().describe('One line on how the call concluded — recorded on the run.'),
    }),
    flags: llm.ToolFlag.NONE,
    execute: async ({ reason }) => {
      await args.record('tool_call', { toolName: 'end_call', category: 'phone_call', input: { reason } }).catch(() => {})
      // Result lands with the call, not after it: the activity feed pairs calls
      // with results, and this one's outcome is the hangup itself.
      await args.record('tool_result', { toolName: 'end_call', output: { ended: true, reason } }).catch(() => {})
      args.hangUp(reason)
      return { ended: true, note: 'The line is closing — finish your goodbye if any words are left, nothing more.' }
    },
  }) as unknown as llm.FunctionTool

  // Handing the caller to a human is not a shared ability: it acts on this
  // room's SIP leg, so it exists only where there is one.
  if (args.transfer) {
    const transfer = args.transfer
    tools.transfer_call = llm.tool({
      description:
        'Transfer the person on the line to a human colleague at their extension. Tell them who you are putting them through to first — the transfer is final and takes you off the call.',
      parameters: z.object({
        extension: z.string().describe("The colleague's extension, or a full number with country code."),
        reason: z.string().describe('Why the call is being transferred — recorded on the run.'),
      }),
      flags: llm.ToolFlag.NONE,
      execute: async ({ extension, reason }) => {
        await args
          .record('tool_call', { toolName: 'transfer_call', category: 'phone_call', input: { extension, reason } })
          .catch(() => {})
        const result = await transfer({ extension, reason })
        await args.record('tool_result', { toolName: 'transfer_call', output: result }).catch(() => {})
        if (!result.transferred) {
          return {
            ...result,
            note: 'Tell them the transfer did not go through, apologize, and carry on with the call yourself.',
          }
        }
        return {
          transferred: true,
          note: `The line is on its way to ${extension.trim()}. Say nothing further — you are off this call.`,
        }
      },
    }) as unknown as llm.FunctionTool
  }

  // Two of the agent's own abilities are genuinely part of talking: committing
  // to work that outlives the call, and writing down something the caller just
  // told you. Both are lifted out of the assembled set by name rather than
  // rebuilt, so they behave exactly as they do on an email run.
  const surfaced: Record<string, string> = { take_assignment: 'take_assignment', remember: 'save_memory' }
  for (const [toolName, abilityName] of Object.entries(surfaced)) {
    const ability = args.abilities.find((candidate) => candidate.name === abilityName && candidate.tool.execute)
    if (!ability) {
      args.onError(`the ${abilityName} ability is missing — ${toolName} is not on this call`)
      continue
    }
    tools[toolName] = surfacedAbility({ ability, governance: args.governance, record: args.record })
  }

  return tools
}
