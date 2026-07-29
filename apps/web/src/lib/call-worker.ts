import { takeAbilityFrame, type Ability, type AbilityFrame, type RunEvent } from '@bunkhouse/runtime'
import type { people, RunTrigger } from '../db/schema'
import { executeAgentRun } from './agent-runs'
import { describeToolCall } from './call-activity'
import type { DeliveryKind } from './call-mailbox'
import { closeBrowserSession } from './browser-use'

/**
 * The worker on a call.
 *
 * A call is two things at once: a conversation and a piece of work. The talker
 * — the voice session — owns the conversation and must never be blocked. The
 * work runs beside it, on the same engine every other piece of an agent's work
 * runs on: `executeAgentRun`, in its live disposition. Same governed loop,
 * same autonomy dial, same approvals, same salary metering, same append-only
 * ledger. What differs is only disposition — whether the caller is waiting on
 * the answer now (here) or the work outlives the call and arrives by email
 * (`take_assignment`, run by the background worker process). One capability,
 * a choice about timing.
 *
 * This file is deliberately thin: it holds handles, turns the run's events
 * into words a person could say, puts the pictures browser steps produce in
 * front of the talker, and stops everything when the call ends. It contains no
 * loop of its own — if it ever needs one, that belongs in `agent-runs.ts`
 * where both dispositions can share it.
 *
 * Imported only by the voice agent process; the web app never bundles this.
 */

type PersonRow = typeof people.$inferSelect

/** Where one piece of handed-over work has got to. */
export type WorkStatus =
  /** Still going. */
  | 'working'
  /** Finished, with a result to read out. */
  | 'done'
  /** Parked on a human decision — not a failure. */
  | 'needs_approval'
  /** It could not be done, and the detail says why. */
  | 'failed'
  /** The call ended underneath it. */
  | 'stopped'

/** One piece of work, as the talker should describe it out loud. */
export type WorkReport = {
  /** The handle the talker was given when it handed the work over. */
  id: string
  /** What was asked for, in the words it was asked in. */
  intent: string
  status: WorkStatus
  /** The latest thing that happened, or the outcome — plain spoken words. */
  detail: string
  /** Seconds since the work was handed over. */
  runningForSeconds: number
}

/** A handle on work that has just been started. */
export type StartedWork = {
  id: string
  /** Settles when the work finishes, fails, parks on approval, or is stopped. */
  settled: Promise<WorkReport>
}

/**
 * One thing worth telling the caller, and how badly it wants to be heard.
 *
 * Deliberately not a line to speak: this is a *post*, and where it goes is the
 * mailbox's business. The worker says what happened; the mailbox decides
 * whether it is still worth saying by the time the line is quiet, and coalesces
 * it with whatever else is waiting.
 *
 * A result is not among the kinds a worker emits: the answer travels back as
 * `do_work`'s own return value, which the framework already speaks at the turn
 * tail in the agent's words.
 */
export type WorkNote = {
  /** The handle the talker was given when it handed the work over. */
  workId: string
  kind: Exclude<DeliveryKind, 'result'>
  /** What a person would say. Plain words, no mechanics. */
  text: string
}

/** How the talker hears about work while it runs. */
export type WorkHooks = {
  /** One note per thing that happened that a colleague would mention. */
  onNote?: (note: WorkNote) => void
}

export type CallWorker = {
  /**
   * Hand over an intent. Returns immediately — the run happens beside the
   * call, and nothing here ever waits on it.
   */
  startWork: (intent: string, hooks?: WorkHooks) => StartedWork
  /** Every piece of work this call has handed over, in the order it was. */
  checkWork: () => WorkReport[]
  /** The call is over: stop everything still running and close the browser. */
  stop: (reason: string) => Promise<void>
}

/**
 * Anything thrown, rendered so a log line and the run ledger both stay
 * readable. A bare `String(error)` on a non-Error object writes "[object
 * Object]" into the record, which costs a diagnostic round trip every time.
 */
export function describeError(error: unknown): string {
  if (typeof error === 'string') return error
  if (error !== null && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message.trim()
    try {
      const own = JSON.stringify(error, Object.getOwnPropertyNames(error))
      if (own && own !== '{}' && own !== 'null') return own
    } catch {
      // Circular or otherwise unserializable — fall through to String().
    }
  }
  return String(error)
}

/** What a settled tool call amounts to, in words. */
function describeToolResult(label: string, output: unknown): string {
  if (output !== null && typeof output === 'object') {
    const record = output as Record<string, unknown>
    if (typeof record.error === 'string' && record.error.trim()) {
      return `${label} — that did not work: ${record.error.trim()}`
    }
    if (record.status === 'forbidden') return `${label} — not something you are allowed to do.`
    if (record.status === 'pending_approval') return `${label} — waiting on a human to sign it off.`
  }
  return `${label} — done.`
}

/** The brief the work runs on: the caller's ask, framed as live work. */
function workInstruction(args: { intent: string; caller: string; agentName: string }): string {
  return [
    `You are on a live call with ${args.caller} right now, and they are waiting on this:`,
    '',
    args.intent,
    '',
    'Do it now, end to end, with the tools you have — this is live work, not a plan and not a promise to do it later.',
    'Be relentless. A 403, a bot check, a dead domain, an empty search: that is the first thing you tried, not a verdict. Go straight to the next route — the official site, a result you have not opened, a directory or aggregator, the cached or printable version, a different phrasing, the browser instead of a plain fetch — and make three or four genuine attempts down different paths before you report any difficulty.',
    `Finish by answering with what ${args.agentName} should say out loud: one or two plain sentences with the actual facts in them, no markdown, no lists, no headings. If you genuinely could not get there, say exactly what you tried and what stopped you.`,
  ].join('\n')
}

/**
 * Put the eyes on every picture a step produces. The run's own model gets the
 * frame in its tool result the ordinary way; this hands the same picture to
 * the call, where it goes in front of the talker between turns.
 */
function watchedForFrames(abilities: Ability[], onFrame: (frame: AbilityFrame) => Promise<void>): Ability[] {
  return abilities.map((ability) => {
    const base = ability.tool
    if (!base.execute) return ability
    const execute = base.execute.bind(base)
    const watched = async (...callArgs: Parameters<typeof execute>) => {
      const raw = await execute(...callArgs)
      const { frame } = takeAbilityFrame(raw)
      if (frame) await onFrame(frame)
      return raw
    }
    return { ...ability, tool: { ...base, execute: watched } }
  })
}

export function createCallWorker(args: {
  tenantId: string
  person: PersonRow
  /** The call's run — every event, every dollar, and the browser hang off it. */
  runId: string
  /** How the call itself was triggered; the work inherits it. */
  trigger: RunTrigger
  /** The agent's whole ability set, assembled once for this call. */
  abilities: Ability[]
  /** Who is on the line, for the work's own sense of what it is doing. */
  caller: string
  /** Append to the call's run ledger. The voice agent owns the numbering. */
  record: (kind: string, payload: Record<string, unknown>) => Promise<void>
  /** A picture a step produced — the call's eyes put it in front of the talker. */
  onFrame: (frame: AbilityFrame) => Promise<void>
  /** Operator-facing log line for anything that goes wrong along the way. */
  onError: (message: string) => void
}): CallWorker {
  const { person, runId } = args

  type Item = {
    id: string
    intent: string
    status: WorkStatus
    detail: string
    startedAt: number
  }
  const items: Item[] = []
  const stopping = new AbortController()
  let stopped = false
  let counter = 0

  // A page the caller is waiting on gets VISITED, not fetched. read_webpage is
  // quick and invisible: nothing appears on the screen of the person watching,
  // and a site whose menu is images or needs a click comes back empty — which
  // is exactly what happened when a caller could see the menu on their screen
  // while the agent said it was still looking. Asking nicely in the tool's
  // description did not move the model off it, so on a call it is simply not
  // there and the browser is the only way to read a page. Every other
  // disposition keeps it: an email run has nobody watching and wants the fast
  // path.
  const visible = args.abilities.filter((ability) => ability.name !== 'read_webpage')
  const abilities = watchedForFrames(visible, async (frame) => {
    try {
      await args.onFrame(frame)
    } catch (error) {
      args.onError(`a picture from the agent's browser could not be shown: ${describeError(error)}`)
    }
  })

  const report = (item: Item): WorkReport => ({
    id: item.id,
    intent: item.intent,
    status: item.status,
    detail: item.detail,
    runningForSeconds: Math.max(0, Math.round((Date.now() - item.startedAt) / 1000)),
  })

  const run = async (item: Item, hooks: WorkHooks | undefined): Promise<WorkReport> => {
    // Two different things, deliberately separated: what the work is doing,
    // and what is worth telling the caller about it.
    //
    // A colleague looking something up for you does not read their own actions
    // back — "opening the site", "read the site", "searching again". They work,
    // and every so often they say where they are up to.
    //
    // So: the detail is updated on everything (check_work reads it, and it
    // costs nothing), while a *post* is reserved for what a person would
    // actually mention — where they are up to, trouble, and a decision that
    // needs a manager. Posting is not speaking: the mailbox holds each post
    // until the line is quiet, coalesces it with anything else waiting, and
    // drops it if a newer one about the same work has already turned up. That
    // is why every step can be posted now, where an earlier version had to go
    // silent to stop the agent cutting itself off mid-sentence.
    const note = (line: string) => {
      item.detail = line
    }
    const post = (kind: WorkNote['kind'], line: string) => {
      item.detail = line
      hooks?.onNote?.({ workId: item.id, kind, text: line })
    }
    // Tool calls and their results are paired first-in-first-out per tool, the
    // same way the call page pairs the ledger it renders.
    const openLabels = new Map<string, string[]>()

    /**
     * The call's ledger, and its narration. One sink does both: every event
     * the governed loop emits lands on the call's run exactly as it would on
     * an email run's, and the same event becomes a line the agent can say.
     */
    const event = async (raw: RunEvent) => {
      const { kind, ...payload } = raw
      await args.record(kind, payload).catch(() => {})
      switch (raw.kind) {
        case 'tool_call': {
          const label = describeToolCall(raw.toolName, raw.input)
          const queue = openLabels.get(raw.toolName) ?? []
          queue.push(label)
          openLabels.set(raw.toolName, queue)
          // The genuine progress line: "Reading example.com", "Searching the
          // web — 'galvanised pipe'". The same words `describeToolCall` puts
          // on the call page, so what the caller hears and what the operator
          // watches are one story from one ledger. Posting every step is safe
          // precisely because the mailbox rate-limits progress and keeps only
          // the newest per piece of work — the caller hears roughly one of
          // these per pause, not one per tool call.
          post('progress', label)
          return
        }
        case 'tool_result': {
          const label = openLabels.get(raw.toolName)?.shift() ?? describeToolCall(raw.toolName, undefined)
          // Noted, never posted: "read the page" the moment after "reading the
          // page" is the agent narrating its own hands, and a step that failed
          // is not the work failing — the loop is expected to try the next
          // route without announcing the last one. The call page shows every
          // one of these; the caller does not need them read out.
          note(describeToolResult(label, raw.output))
          return
        }
        case 'approval_request':
          // The description is rendered by `describeToolCall`, so it is already
          // the same human label a tool call gets.
          post('needs_approval', `${raw.description} — it needs a manager's sign-off before it can happen.`)
          return
        case 'message': {
          // The loop's own prose — its working notes to itself. It belongs on
          // the run record, not in the agent's mouth: reading it out is how
          // the agent ends up narrating its own thinking mid-sentence.
          const text = raw.text.trim()
          if (text) note(text)
          return
        }
        case 'error':
          // 'failed' names how urgently this wants to be heard, not the run's
          // final verdict — the loop may well recover. Trouble a caller could
          // act on is worth breaking a short silence for either way.
          post('failed', `That ran into trouble: ${raw.message}`)
          return
        case 'procedure_citation':
          return
      }
    }

    const { outcome } = await executeAgentRun({
      tenantId: args.tenantId,
      personId: person.id,
      trigger: args.trigger,
      input: {
        type: 'manual',
        instruction: workInstruction({ intent: item.intent, caller: args.caller, agentName: person.name }),
      },
      live: { runId, event, abilities, abortSignal: stopping.signal },
    })

    if (stopped) {
      item.status = 'stopped'
      item.detail = 'The call ended before this finished.'
      return report(item)
    }
    switch (outcome.status) {
      case 'completed':
        item.status = 'done'
        item.detail = outcome.summary.trim() || 'It is done.'
        break
      case 'waiting_approval':
        // Not a failure: the work reached something a person has to decide.
        // `item.detail` is already the approval line the sink narrated.
        item.status = 'needs_approval'
        break
      case 'waiting_reply':
        // A live call carries no ask_and_wait, so nothing should reach here;
        // if it ever does, say the honest thing rather than claiming success.
        item.status = 'needs_approval'
        item.detail = `This is waiting on ${outcome.wait.to} to answer by email.`
        break
      case 'budget_paused':
        item.status = 'failed'
        item.detail = 'This could not run: the monthly budget for this agent is used up.'
        break
      case 'failed':
        item.status = 'failed'
        item.detail = outcome.error
        break
    }
    return report(item)
  }

  return {
    startWork: (intent, hooks) => {
      counter += 1
      const item: Item = {
        id: `work-${counter}`,
        intent,
        status: 'working',
        detail: 'Just handed over — nothing back yet.',
        startedAt: Date.now(),
      }
      items.push(item)
      const settled = run(item, hooks).catch((error: unknown) => {
        const message = describeError(error)
        args.onError(`work "${intent}" fell over: ${message}`)
        item.status = 'failed'
        item.detail = message
        void args.record('error', { message: `Work started on the call failed: ${message}` }).catch(() => {})
        return report(item)
      })
      return { id: item.id, settled }
    },
    checkWork: () => items.map(report),
    stop: async (reason) => {
      if (stopped) return
      stopped = true
      const live = items.filter((item) => item.status === 'working')
      stopping.abort(new Error(reason))
      if (live.length > 0) {
        await args
          .record('message', {
            text: `${live.length} piece${live.length === 1 ? '' : 's'} of work stopped when the call ended: ${live
              .map((item) => item.intent)
              .join('; ')}`,
          })
          .catch(() => {})
      }
      // The browser this call opened belongs to the call, not to one request.
      await closeBrowserSession(runId).catch((error: unknown) =>
        args.onError(`the browser could not be closed: ${describeError(error)}`),
      )
    },
  }
}
