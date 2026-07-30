import {
  takeAbilityFrame,
  type Ability,
  type AbilityFrame,
  type AutonomyResolver,
  type RunEvent,
} from '@bunkhouse/runtime'
import type { people, RunTrigger } from '../db/schema'
import { executeAgentRun } from './agent-runs'
import { describeToolCall } from './call-activity'
import type { DeliveryKind } from './call-mailbox'
import { resolvePageAccess, toolsPromisedButAbsent, type PageAccess } from './call-reading'
import { pageReadingAbility, type SeeingModel } from './page-reading'
import type { CallTrace } from './call-trace'
import { browserSupported, closeBrowserSession } from './browser-use'

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
  /** True while a piece of work the caller is waiting on is still running. */
  working: () => boolean
  /**
   * How this call reads a web page, and why. Resolved once, before the first
   * intent is handed over, so the talker's own instructions can say the same
   * thing the worker will actually be able to do.
   */
  pageAccess: PageAccess
  /**
   * Every ability the work can actually reach. The talker's instructions
   * describe this kit as well as its own six tools, so the check that no
   * instruction promises an absent tool has to know about both.
   */
  abilityNames: string[]
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

/**
 * Whether a tool came back parked on a human decision.
 *
 * The governed loop files the approval and emits an `approval_request` event
 * for a first park, but a repeat of the same call is deduplicated against the
 * record and emits no event at all — so the tool's own result is the only
 * remaining sign that nothing happened. Reading it here is what stops the
 * second and third attempt at a gated action from passing in silence.
 */
function parkedOnApproval(output: unknown): boolean {
  if (output === null || typeof output !== 'object') return false
  return (output as Record<string, unknown>).status === 'pending_approval'
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

/**
 * The brief the work runs on: the caller's ask, framed as live work.
 *
 * Deliberately NOT a research brief. An earlier version was six paragraphs and
 * five of them were about web pages — relentless sources, stale snippets,
 * primary sources — so a run handed "email Dana the answer and put it in the
 * shared folder" read a brief describing a web researcher and behaved like
 * one. The kit is the same kit an email run gets, assembled once by
 * `assembleAbilities` and handed in whole: the workspace and its shell, files,
 * documents and spreadsheets, email and messages, the logbook, scheduling,
 * every connected integration, every skill and procedure this agent has. The
 * frame says so first, and the source discipline is a clause that applies WHEN
 * the work involves looking something up — which is often, but is not what
 * the work is.
 */
function workInstruction(args: { intent: string; caller: string; agentName: string; pageAccess: PageAccess }): string {
  return [
    `You are on a live call with ${args.caller} right now, and they are waiting on this:`,
    '',
    args.intent,
    '',
    'Do it now, end to end, with everything you have — this is live work, not a plan and not a promise to do it later. Your whole working kit is on this run, exactly as it is on any other: your workspace and its shell, real files, documents and spreadsheets, email and messages, your logbook, scheduling, every integration connected to you, and every skill and procedure you have been given. Use whichever of them the job actually needs, and follow a procedure that covers this if you have one. Looking something up is one of the things you can do here, not the whole of what you do.',
    'Be relentless, whatever the job is. The first thing that does not work is the first thing you tried, not a verdict: a 403, a bot check, a dead domain, an empty search, a file that is not where you expected, a step that errors. Go straight to the next route and make three or four genuine attempts down different paths before you report any difficulty.',
    // Stale recommendations, and the call that earned this paragraph: the agent
    // recommended a restaurant that had closed, off a search snippet whose own
    // text showed the address now advertising a different business. A search
    // index is a memory of a page, not the page — and everything a caller acts
    // on today (open or closed, hours, price, availability, in stock, still
    // trading) is exactly the part of a page that goes out of date first.
    'When the job does involve looking something up: a search result is a MEMORY of a page, not the page. Anything perishable — whether a place is open or has closed, opening hours, prices, availability, whether something is in stock, whether a business still exists — must be read off the primary source itself: the business\'s own site, its own booking or ordering page, its own listing on the platform that takes its bookings. Never state a perishable fact on the strength of a search snippet, a cached description, or a directory entry alone.',
    'Read the source you land on for signs it has moved on: a different business name on the same address, a "permanently closed" notice, a parked or for-sale domain, a site whose latest news is years old, hours that contradict the snippet that sent you there. When the snippet and the source disagree, the source is right and the disagreement is itself worth reporting.',
    'If you could not verify a perishable fact against a primary source, say so in your answer, in plain words, and say what you did see — "their own site is down, so this is from a listing that may be out of date". An unverified fact presented as a verified one is the worst outcome available here; saying you could not check is never the worst outcome.',
    ...(args.pageAccess.work ? [args.pageAccess.work] : []),
    `Finish by answering with what ${args.agentName} should say out loud: one or two plain sentences with the actual facts in them — what you did, and what came of it — with no markdown, no lists and no headings. If you genuinely could not get there, say exactly what you tried and what stopped you.`,
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
  /**
   * A model that can look at a picture, or null when the company has connected
   * nothing that can. Resolved once, before the first word: whether an agent
   * can see is a property of the system, not of whichever model an operator
   * assigned it, and a page built from images is unreadable without one.
   */
  seeing: SeeingModel
  /**
   * The autonomy dial. The worker's own governed loop applies it per tool call;
   * this copy answers one question before the work starts — whether the browser
   * is genuinely usable on this call, or whether every page would park on a
   * sign-off nobody is going to give mid-conversation.
   */
  autonomy: AutonomyResolver
  /** Who is on the line, for the work's own sense of what it is doing. */
  caller: string
  /** Append to the call's run ledger. The voice agent owns the numbering. */
  record: (kind: string, payload: Record<string, unknown>) => Promise<void>
  /** The call's operational record: what was handed over, and what became of it. */
  trace: CallTrace
  /**
   * Hand a piece of work to the deferred disposition — an assignment, run by
   * the background worker and delivered by email. Used when the call ends
   * underneath work somebody was waiting on: the answer then arrives late
   * rather than never. Owned by the caller because filing one needs a tenant
   * scope and a recipient, neither of which belongs in here.
   */
  defer: (work: { intent: string; latest: string }) => Promise<{ refiled: boolean; reason: string; assignmentId?: string }>
  /** A picture a step produced — the call's eyes put it in front of the talker. */
  onFrame: (frame: AbilityFrame) => Promise<void>
  /** Operator-facing log line for anything that goes wrong along the way. */
  onError: (message: string) => void
}): CallWorker {
  const { person, runId, trace } = args

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
  // description did not move the model off it, so where the browser is usable
  // it is simply not there. Every other disposition keeps it: an email run has
  // nobody watching and wants the fast path.
  //
  // "Where the browser is usable" is the whole of it, and withdrawing the fetch
  // path without checking that was a regression of its own: an agent whose
  // computer_use dial sits on 'approval' parks every browser_open awaiting a
  // sign-off that will not arrive mid-call, so it had NO way to read a page and
  // silently answered from search snippets instead. The rule now lives in
  // call-reading.ts, and it is never allowed to leave the worker with neither
  // route. `browserSupported()` is consulted directly as well as through the
  // assembled set, so a platform with no Chromium reads as one reason rather
  // than as an ability that mysteriously is not there.
  const pageAccess = resolvePageAccess({
    abilityNames: browserSupported()
      ? args.abilities.map((ability) => ability.name)
      : args.abilities.map((ability) => ability.name).filter((name) => !name.startsWith('browser_')),
    computerUse: args.autonomy('computer_use'),
    ...(() => {
      const opener = args.abilities.find((ability) => ability.name === 'browser_open')
      return opener?.approval ? { browserApproval: opener.approval } : {}
    })(),
  })
  trace.pageAccess({ route: pageAccess.route, reason: pageAccess.reason })
  // ONE PERCEPTION. `read_webpage` and `browser_open` were two ways to learn
  // what a page says, and the model chose between them badly every time: it
  // fetched a menu built from images four times and reported "still looking"
  // while the caller watched that menu on their own screen. Withdrawing the
  // fetch to force a visit only moved the failure — an agent whose dial parks
  // the browser was left unable to read anything at all. Both are now routes
  // inside one ability, chosen here rather than by the model: fetch because it
  // is cheap, the browser when that comes back thin, and a model that can see
  // describing the picture when the page has no text to give. The browser's
  // ACTING tools are untouched; this contract is about reading.
  const opener = args.abilities.find((ability) => ability.name === 'browser_open')
  const visit =
    pageAccess.route === 'browser' && opener?.tool.execute
      ? async (url: string) => opener.tool.execute!({ url } as never, { toolCallId: 'read_page', messages: [] } as never)
      : null
  const reading = pageReadingAbility({
    visit,
    seeing: args.seeing,
    onRoute: (page) => trace.pageAccess({ route: page.route, reason: page.unreadable ?? page.url }),
  })
  const visible = [...args.abilities.filter((ability) => ability.name !== 'read_webpage'), reading]
  // Contract three, enforced rather than remembered: the brief the work runs
  // on may not name a tool the work does not hold. The frame is checked once —
  // the intent is the caller's own words and is not part of the promise.
  const promised = toolsPromisedButAbsent(
    workInstruction({ intent: '', caller: args.caller, agentName: person.name, pageAccess }),
    visible.map((ability) => ability.name),
  )
  if (promised.length > 0) {
    args.onError(`the work brief names tools this call does not have: ${promised.join(', ')}`)
    void args.record('error', { message: `Call brief promised absent tools: ${promised.join(', ')}` }).catch(() => {})
  }

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
          // A step parked on a human decision is the one result that IS worth
          // saying out loud: the caller can act on it while they are still on
          // the phone, and an agent that stays quiet about it just goes and
          // does something worse — which is precisely what happened when three
          // browser_open calls in one call were queued for sign-off and the
          // caller was told nothing. Deliberately the same words the
          // approval_request post uses, so when both fire for one park the
          // mailbox's deduplication keeps it to one line rather than two.
          if (parkedOnApproval(raw.output)) {
            post('needs_approval', `${label} — it needs a manager's sign-off before it can happen.`)
            return
          }
          // Otherwise noted, never posted: "read the page" the moment after
          // "reading the page" is the agent narrating its own hands, and a step
          // that failed is not the work failing — the loop is expected to try
          // the next route without announcing the last one. The call page shows
          // every one of these; the caller does not need them read out.
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
        instruction: workInstruction({
          intent: item.intent,
          caller: args.caller,
          agentName: person.name,
          pageAccess,
        }),
      },
      live: { runId, event, abilities, abortSignal: stopping.signal },
    })

    switch (outcome.status) {
      case 'completed':
        // Never overwritten by the call ending, and this is the whole of
        // defect 4: the old code checked `stopped` FIRST and replaced a real,
        // finished answer with "The call ended before this finished." An answer
        // the agent had reached — read off a browser screenshot, in the run
        // that produced it — was thrown away, `do_work` returned a bare
        // 'stopped' report, and the model filled the silence from the stale
        // list it had seen minutes earlier. The answer exists; it goes in the
        // record whatever else has happened, and whether anyone got to hear it
        // is a separate fact the trace keeps separately.
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
        // A run the call aborted underneath comes back failed with the abort's
        // own message, which is not a fault worth naming to anybody: the caller
        // hung up, that is all. Say what actually happened instead.
        if (stopped) {
          item.status = 'stopped'
          item.detail = 'The call ended before this finished.'
          break
        }
        item.status = 'failed'
        item.detail = outcome.error
        break
    }
    const settled = report(item)
    trace.settled({
      workId: item.id,
      status: settled.status,
      answer: settled.detail,
      seconds: settled.runningForSeconds,
    })
    return settled
  }

  return {
    pageAccess,
    abilityNames: visible.map((ability) => ability.name),
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
      trace.handedOver({ workId: item.id, intent })
      const settled = run(item, hooks).catch((error: unknown) => {
        const message = describeError(error)
        args.onError(`work "${intent}" fell over: ${message}`)
        item.status = 'failed'
        item.detail = message
        void args.record('error', { message: `Work started on the call failed: ${message}` }).catch(() => {})
        const failed = report(item)
        trace.settled({
          workId: item.id,
          status: failed.status,
          answer: failed.detail,
          seconds: failed.runningForSeconds,
        })
        return failed
      })
      return { id: item.id, settled }
    },
    checkWork: () => items.map(report),
    working: () => items.some((item) => item.status === 'working'),
    stop: async (reason) => {
      if (stopped) return
      stopped = true
      const live = items.filter((item) => item.status === 'working')
      // Refile before aborting, not after: work the caller was waiting on
      // must not simply evaporate when the line goes down. The deferred
      // disposition already exists for work that outlives a call — the same
      // engine, queued, delivered by email — so the answer arrives late
      // instead of never. Where it cannot be refiled (nobody to send it to on
      // an anonymous phone call) the trace says so as an error, because "the
      // caller never got their answer" is not something to discover later.
      for (const item of live) {
        try {
          const outcome = await args.defer({ intent: item.intent, latest: item.detail })
          trace.deferred({
            workId: item.id,
            refiled: outcome.refiled,
            reason: outcome.reason,
            ...(outcome.assignmentId ? { assignmentId: outcome.assignmentId } : {}),
          })
        } catch (error) {
          const message = describeError(error)
          args.onError(`work "${item.intent}" could not be refiled to finish after the call: ${message}`)
          trace.deferred({ workId: item.id, refiled: false, reason: message })
        }
      }
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
