import { randomUUID } from 'node:crypto'
import { llm } from '@livekit/agents'
import { z } from 'zod'
import type { Ability, ActionCategory, AutonomyLevel } from '@bunkhouse/runtime'
import { describeToolCall } from './call-activity'
import type { CallMailbox } from './call-mailbox'
import type { CallTrace } from './call-trace'
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
 * on. The tool's eventual return value arrives the same way, as the result the
 * agent reads out. There is no filler timer.
 *
 * Everything between those two moments goes through the mailbox instead. A
 * line handed straight to the talker becomes a fresh reply, and a fresh reply
 * lands on top of whatever was already in the caller's ear — so a running
 * commentary did not sound attentive, it sounded like someone breaking off
 * mid-sentence to start a different thought. The mailbox holds each post until
 * the line is genuinely quiet, coalesces everything waiting into one message,
 * and drops what has gone stale. That is what makes real progress reporting
 * safe rather than something to be deleted.
 *
 * Imported only by the voice agent process; the web app never bundles this.
 */

/**
 * One of the talker's tools, with its arguments and result erased. Each tool
 * has its own schema and its own result, so a map of them has no narrower
 * type — the framework's own `ToolDefinitionMap` is keyed exactly this way.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type AnyTalkerTool = llm.AnonFunctionTool<any, unknown, any>

/** How the agent should hear about the work it just handed over. */
const HANDED_OVER =
  'It is running now, beside this call. You have ALREADY told the caller you are on it, so do not announce it again — repeating yourself the moment you have handed something over is what makes an agent sound like it is stammering. Say nothing about this handover. Just carry on the conversation you were having: answer what they asked, ask what you still need to know to make the result useful, or make ordinary conversation. You will be told where it has got to as it goes, and the result comes back to you when it is ready.'

/** One line per piece of work, for `check_work` and for the model to read. */
function readable(report: WorkReport): Record<string, unknown> {
  // Collected rather than overwritten: "this is parked on a sign-off" and "you
  // have already said this" are both true at once on a parked piece of work,
  // and dropping either one loses something the caller is owed.
  const notes: string[] = []
  if (report.status === 'stopped') {
    // A model handed a report with no answer in it will produce an answer
    // anyway, from whatever it happens to be holding — a list it saw two
    // minutes ago, a search snippet from the first attempt. That is exactly how
    // a caller was read a stale list of restaurants while the real answer sat
    // finished in the record. So a report with no answer says so in words.
    notes.push(
      'No answer came back for this. Do NOT answer from memory, from anything you saw earlier in the call, or from a guess: say plainly that you did not get it, and offer to finish it and send it on.',
    )
  }
  if (report.status === 'needs_approval') {
    notes.push(
      'This is parked on a human decision. Tell the caller it needs their sign-off and will happen once it is signed off — never that it is done.',
    )
  }
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
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
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
  /**
   * Where a parked approval is announced from. A tool result telling the model
   * to mention the sign-off is not enough on its own — a model reading a JSON
   * result decides for itself whether it is worth saying, and on the call this
   * was found on it decided not to, three times. The mailbox is the one route
   * that carries interrupt priority and cannot be talked out of it.
   */
  needsApproval: (post: { workId: string; text: string }) => void
}): AnyTalkerTool {
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
            // Both routes, deliberately. The approval is keyed on the approval
            // id rather than on a piece of work, so the same park announced from
            // the loop and from here is one line, not two.
            args.needsApproval({
              workId: `approval-${approvalId}`,
              text: `${description} — it needs a manager's sign-off before it can happen.`,
            })
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
  })
}

export function callTools(args: {
  /** The worker this call hands its work to. */
  worker: CallWorker
  /**
   * Where everything the work has to say is queued until the line is quiet.
   * Constructed per call, alongside the session whose state it reads.
   */
  mailbox: CallMailbox
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
   * The call's operational record. `do_work` uses it for the one fact neither
   * ledger holds: whether the answer it just got was ever spoken to the caller.
   */
  trace: CallTrace
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
}): Record<string, AnyTalkerTool> {
  const { mailbox, worker } = args
  const tools: Record<string, AnyTalkerTool> = {}

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
      // Nothing the work says goes near `ctx.update` any more: every note is
      // posted to the mailbox, which is the one thing on this call that
      // decides when the caller can be spoken to. Several pieces of work can
      // be running at once, and they all queue into the same mailbox, so what
      // lands at a boundary is one message rather than one per worker.
      const work = worker.startWork(intent, { onNote: (note) => mailbox.post(note) })
      // The one exception, and it is not a delivery: this first update is what
      // answers the model in milliseconds and turns the call non-blocking. It
      // never reaches the caller as speech, so it cannot cancel any.
      await ctx.update(`Working on it now, under the handle ${work.id}. ${HANDED_OVER}`)
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
      // framework is told there is no deferred reply to make. The work itself
      // is not abandoned — the call's teardown refiles anything still running
      // through the deferred disposition, so the answer arrives by email — and
      // the trace records that this caller never heard it.
      if (!settled) return null
      // Has the caller heard these exact words already? Asked BEFORE the
      // mailbox is told, because telling it is what stamps them as said. An
      // approval line is the case that bites: the mailbox says it at a quiet
      // boundary the moment the loop parks, and a few seconds later this
      // report says it again at the turn tail — two byte-identical rows in
      // `call_turns`, which is what a caller hears as a stuck line.
      const alreadyHeard = mailbox.said({ workId: work.id, text: settled.detail })
      // The answer travels back as this tool's return value — the framework's
      // deferred-reply path, which already waits for the turn to end and gives
      // the agent its own words for it. Telling the mailbox it has been said
      // is what retires the work: progress still queued about it is dropped,
      // so "still looking at the site" can never land behind the answer, and
      // the same words can never go out twice by two routes.
      mailbox.delivered({ kind: 'result', workId: work.id, text: settled.detail })
      if (alreadyHeard) {
        // Returning nothing is the framework's "no deferred reply", the same
        // answer given when the line is already gone. It is deliberately not a
        // note asking the model to keep quiet: a note leaves the decision with
        // the model, and a model holding an answer says it. One piece of
        // content, one route — the mailbox owns these words, so this route has
        // nothing to hand over and cannot repeat them.
        args.trace.answerAlreadySpoken({
          workId: work.id,
          route: 'the mailbox said these words at a quiet boundary while it was still running',
        })
        return null
      }
      // The framework makes a reply for this return value once the turn ends,
      // so the next thing the agent says IS this answer being read out. That
      // is what marks the answer delivered; if no such turn ever happens, the
      // trace says the answer was produced and never spoken.
      args.trace.expectTurn({ cause: 'work_result', workId: work.id })
      return readable(settled)
    },
  })

  tools.check_work = llm.tool({
    description:
      'See where everything you have handed over has got to — what is still running, what finished, and what is waiting on a human. Use it when the caller asks how it is going, or when you want to be sure before you speak.',
    parameters: z.object({}),
    flags: llm.ToolFlag.NONE,
    execute: async () => {
      const work = worker.checkWork()
      // Asking is a delivery in itself. Everything the mailbox was holding for
      // the next quiet moment is handed over here instead and counted as told,
      // so the agent is not interrupted a second later with what it has just
      // read — and so nothing waiting is invisible to the model that asked.
      const waiting = mailbox.acknowledge()
      if (work.length === 0) {
        return { work: [], note: 'Nothing is running. If the caller has asked for something, hand it over with do_work.' }
      }
      return {
        work: work.map((report) => readable(report)),
        ...(waiting.length > 0 ? { sinceYouLastHeard: waiting.map((item) => item.text) } : {}),
      }
    },
  })

  // Hanging up is the agent's to do when the goodbye is genuinely said — the
  // receiver going down, not a timeout. The tool returns immediately so the
  // model can finish its last words; the hangup waits for that speech to play
  // out, settles the ledger, and then takes the room down, which is what
  // actually ends the call for the caller.
  //
  // Hanging up while the caller's own answer is still coming is how a call ends
  // two seconds before the result lands — and the model, with nothing back, fills
  // the goodbye with something it half-remembers. So the first attempt to hang up
  // on live work is refused and the agent is told to wait for it. Once, and once
  // only: a caller who wants to go must always be able to go, so a second attempt
  // ends the call and the unfinished work is refiled to arrive by email.
  let refusedHangupOnce = false

  tools.end_call = llm.tool({
    description:
      'Hang up the call. Use only when the conversation has reached its natural end — the work is agreed or done and goodbyes have been said. Never to cut someone off.',
    parameters: z.object({
      reason: z.string().describe('One line on how the call concluded — recorded on the run.'),
    }),
    flags: llm.ToolFlag.NONE,
    execute: async ({ reason }) => {
      await args.record('tool_call', { toolName: 'end_call', category: 'phone_call', input: { reason } }).catch(() => {})
      if (!refusedHangupOnce && worker.working()) {
        refusedHangupOnce = true
        const output = {
          ended: false,
          note: 'Not yet — something the caller asked for is still running and the answer is close. Stay on the line: tell them you are just waiting on the last of it, keep them company for a moment, and read the answer out when it lands. If they genuinely need to go, offer to finish it and send it on, then hang up.',
        }
        await args.record('tool_result', { toolName: 'end_call', output }).catch(() => {})
        return output
      }
      // Result lands with the call, not after it: the activity feed pairs calls
      // with results, and this one's outcome is the hangup itself.
      await args.record('tool_result', { toolName: 'end_call', output: { ended: true, reason } }).catch(() => {})
      args.hangUp(reason)
      return { ended: true, note: 'The line is closing — finish your goodbye if any words are left, nothing more.' }
    },
  })

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
    })
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
    tools[toolName] = surfacedAbility({
      ability,
      governance: args.governance,
      record: args.record,
      needsApproval: (post) => mailbox.post({ kind: 'needs_approval', ...post }),
    })
  }

  return tools
}
