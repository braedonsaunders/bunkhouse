/**
 * The delivery mailbox: what the work has to say, held until the line is quiet.
 *
 * A call is a talker and a worker. Handing work over is solved — `do_work`
 * returns in milliseconds and several pieces can run at once. Handing the
 * *answers back* was not. Every line the worker pushed at the talker became a
 * fresh reply, and a fresh reply lands on top of whatever was already in the
 * caller's ear:
 *
 *     agent 37s  Got it... Let me check what's available.
 *     agent 38s  I'm                          <- one word, cut off
 *     agent 45s  Any preferences on type?     <- a different thought
 *     agent 55s  Understood. I'm seeing...    <- "Understood" to nobody
 *
 * The shape that works is the one a coding agent uses to receive a finished
 * subagent: the result is queued, coalesced with anything else waiting, and
 * delivered at a turn boundary. Never mid-sentence, never as a burst.
 *
 * So this module is a queue with four rules — coalescing, priority, rate
 * limiting, deduplication — and a flush that only fires when the line is
 * genuinely quiet. It is deliberately framework-free: it imports nothing from
 * @livekit/agents and knows nothing about sessions, speech handles or rooms.
 * "Is the line quiet" and "say this" are both callbacks, which is what makes
 * the whole of it testable without a call.
 *
 * Every one of those four rules exists to *not* say something, so each decision
 * is reported as it is made (`onDecision`). Without that, a line the caller
 * needed and a line the caller was spared leave exactly the same trace behind —
 * none — and an approval nobody heard about cannot be told from an approval
 * that was never posted.
 *
 * Imported by the voice agent process and by its test; the web app never
 * bundles either.
 */

/** What a queued line is, which is also how badly it wants to be heard. */
export type DeliveryKind =
  /** Where the work has got to. The most droppable thing there is. */
  | 'progress'
  /** The answer. Never superseded, never dropped. */
  | 'result'
  /** Parked on a human decision — the caller has to be told, and soon. */
  | 'needs_approval'
  /** It ran into trouble. Also worth breaking a silence for. */
  | 'failed'

/**
 * How badly a line wants to be heard, as a number so the rules can compare
 * them. Approvals and failures outrank the answer itself because they are the
 * two things a caller can act on while still on the phone; plain progress
 * ranks bottom because it is the one thing nobody minds never hearing.
 */
export const DELIVERY_PRIORITY: Record<DeliveryKind, number> = {
  progress: 0,
  result: 2,
  needs_approval: 3,
  failed: 3,
}

/** At or above this, a line is worth cutting the settle delay short for. */
const URGENT_PRIORITY = 3

/** Something the work wants said. */
export type MailboxPost = {
  kind: DeliveryKind
  /** What a person would actually say. Plain words, no mechanics. */
  text: string
  /** Which handed-over piece of work this is about. */
  workId: string
  /**
   * Optional override of the kind's own priority, for the caller that knows
   * this particular line matters more (or less) than its kind suggests.
   */
  priority?: number
}

/** A post that has been accepted into the queue. */
export type MailboxItem = {
  kind: DeliveryKind
  text: string
  workId: string
  priority: number
  /** When it was posted — the queue keeps the order the story happened in. */
  postedAt: number
  /**
   * How many times a delivery carrying this produced no words. Nonzero only
   * for something that has already been handed to the mouth and come back
   * unsaid; it bounds the retrying so a model leg that is simply down cannot
   * hold the line open re-asking for ever.
   */
  attempts?: number
}

/** One boundary's worth of mail, as a single message. */
export type MailboxDelivery = {
  /** Everything pending, coalesced. This is what gets said. */
  text: string
  /** The lines it was made of, for the caller that wants the detail. */
  items: readonly MailboxItem[]
}

/**
 * What the mailbox decided about one line, and why.
 *
 * Every rule in this file drops something on purpose, which is exactly what
 * makes the queue safe — and exactly what makes it impossible to explain
 * afterwards why the caller never heard a particular thing. An approval that
 * went out and an approval that was coalesced away leave the same silence
 * behind, and only one of them is a bug. So each decision is reported as it is
 * made, in one flat line the run's own ledger can hold.
 */
export type MailboxDecision = {
  decision:
    /** Queued, and it will be said at the next boundary. */
    | 'posted'
    /** Superseded by a newer line about the same work; never said. */
    | 'coalesced'
    /** Not queued at all, and `reason` says why. */
    | 'dropped'
    /** The caller has been told, by this mailbox or by another route. */
    | 'delivered'
  kind: DeliveryKind
  workId: string
  text: string
  /** Why it was coalesced or dropped, or which route delivered it. */
  reason?: string
}

/** Every delay the mailbox observes, so a test can run in milliseconds. */
export type MailboxTiming = {
  /** How long the line must have been quiet before a flush fires. */
  settleMs: number
  /** The same, for a line that outranks ordinary progress. */
  urgentSettleMs: number
  /** The floor between two progress deliveries. */
  progressIntervalMs: number
  /** The floor after any delivery, whatever it was. */
  afterDeliveryMs: number
}

export const DELIVERY_TIMING: MailboxTiming = {
  /**
   * A reply is not one continuous noise: the agent stops between sentences,
   * and the session drops out of 'speaking' in those gaps. Firing into one of
   * them is exactly the interruption this module exists to prevent, so a
   * boundary has to hold still before it counts as one. Just over a second is
   * longer than any inter-sentence gap and short enough that a caller reads
   * the delivery as a response rather than an afterthought.
   */
  settleMs: 1_200,
  /**
   * An approval or a failure is worth a shorter wait: the caller can act on
   * either one, and both go stale. Still long enough to clear a comma.
   */
  urgentSettleMs: 350,
  /**
   * Progress is company, not information. A colleague looking something up
   * for you says where they are up to about twice a minute; more often than
   * that and they are reading their own hands out loud, which is what made
   * the agent sound like it was stammering in the first place. Twenty seconds
   * is one such remark per unhurried pause.
   */
  progressIntervalMs: 20_000,
  /**
   * The gap after a delivery, before the next one may even be considered.
   * A delivery does not become audible the instant it is handed over — the
   * session has to generate the reply first — so for a moment afterwards the
   * line still reads as quiet when speech is about to start. Without this
   * floor two deliveries land back to back and the second cancels the first,
   * which is the precise failure in the transcript at the top of this file.
   */
  afterDeliveryMs: 2_500,
}

export type CallMailboxOptions = {
  /**
   * True when the line is genuinely quiet: the agent is neither speaking nor
   * thinking, and the caller is not speaking. Read fresh on every decision —
   * never cached — because it is the whole basis of not talking over anyone.
   */
  isQuiet: () => boolean
  /**
   * Say it. Must not resolve until the words are out of the way (ideally when
   * their playout has finished), because the mailbox holds every other
   * delivery until it does.
   */
  /**
   * Say it. Resolves with whether words actually reached the caller — a model
   * leg that errors mid-delivery resolves like any other, and the difference
   * between "said" and "nothing came out" is not observable from here.
   */
  deliver: (delivery: MailboxDelivery) => Promise<{ spoke: boolean } | void>
  /** Operator-facing log line for anything that goes wrong along the way. */
  onError?: (message: string) => void
  /**
   * Every decision the queue makes, as it is made. Optional because the
   * mailbox works without an audience; wired on a real call to the run's
   * ledger, so "why did the caller never hear that" has an answer.
   */
  onDecision?: (decision: MailboxDecision) => void
  /** Overrides for the delays above. Tests scale them down; calls do not. */
  timing?: Partial<MailboxTiming>
}

export type CallMailbox = {
  /** Queue something to be said at the next boundary. */
  post: (item: MailboxPost) => void
  /**
   * Record that the caller has been told this by some other route — the
   * framework speaking a tool's return value, say. Nothing is queued: the
   * post is made so its supersession rules run (a result retires the work,
   * and progress still waiting about that work is dropped), then stamped as
   * said so the same words can never go out twice.
   *
   * A line already *waiting* with these exact words is retired here too. It was
   * queued when nothing else was going to say it; now something is, and leaving
   * it queued is how the caller ends up hearing one sentence twice, seconds
   * apart, from two routes that each believed they were the only one.
   */
  delivered: (item: MailboxPost) => void
  /** What is waiting, oldest first. For `check_work`, and for the tests. */
  pending: () => readonly MailboxItem[]
  /**
   * Hand the whole queue over without speaking it, and count it as told. The
   * model has just asked where things stand, so it is holding everything the
   * mailbox was waiting to interrupt with — saying it at it as well would be
   * repeating itself.
   */
  acknowledge: () => MailboxItem[]
  /**
   * The session's agent or user state changed. This is what drives the whole
   * thing: boundaries are events, not a polling interval.
   */
  notifyStateChanged: () => void
  /** The call is over. Nothing further is queued, and nothing pending is said. */
  close: () => void
}

/** One work's one line — the identity deduplication is done on. */
/** How many silent deliveries a single line is given before it is given up on. */
const MAX_DELIVERY_ATTEMPTS = 3

const identity = (item: { workId: string; text: string }): string => `${item.workId} ${item.text}`

export function createCallMailbox(options: CallMailboxOptions): CallMailbox {
  const timing: MailboxTiming = { ...DELIVERY_TIMING, ...options.timing }
  const queue: MailboxItem[] = []
  /** Every line already said, by this mailbox or by any other route. */
  const said = new Set<string>()
  /** Work whose answer has landed. Nothing older about it is worth saying. */
  const finished = new Set<string>()

  let timer: ReturnType<typeof setTimeout> | null = null
  let delivering = false
  let closed = false
  /** The last answer `isQuiet` gave, so the moment it went quiet is known. */
  let wasQuiet = false
  let quietSince = 0
  // Negative infinity, not zero: nothing has been delivered yet, so no floor
  // applies to the first one. Zero would be a floor that expired in 1970 —
  // the same answer by accident rather than by meaning.
  let lastProgressAt = Number.NEGATIVE_INFINITY
  let lastDeliveryAt = Number.NEGATIVE_INFINITY

  const fail = (message: string) => {
    options.onError?.(message)
  }

  /** Report one decision. Never throws into the queue's own logic. */
  const decide = (
    decision: MailboxDecision['decision'],
    item: { kind: DeliveryKind; workId: string; text: string },
    reason?: string,
  ) => {
    if (!options.onDecision) return
    try {
      options.onDecision({
        decision,
        kind: item.kind,
        workId: item.workId,
        text: item.text,
        ...(reason ? { reason } : {}),
      })
    } catch (error) {
      fail(`a mailbox decision could not be recorded: ${String(error)}`)
    }
  }

  const clearTimer = () => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  /**
   * Ask the line whether it is quiet, and remember when it went that way. A
   * throwing query is treated as a busy line: the one safe answer when the
   * session cannot be read is to say nothing.
   */
  const syncQuiet = (now: number): boolean => {
    let quiet = false
    try {
      quiet = options.isQuiet()
    } catch (error) {
      quiet = false
      fail(`the line's state could not be read, so nothing was delivered: ${String(error)}`)
    }
    if (quiet && !wasQuiet) quietSince = now
    wasQuiet = quiet
    return quiet
  }

  /**
   * The moment an item may open a delivery of its own.
   *
   * Rate limiting is about how often the caller is interrupted, not about
   * which words are in the message — so it gates what can *start* a flush and
   * nothing more. Once an approval or an answer has opened one, the progress
   * line waiting behind it rides along free: coalescing it costs the caller
   * nothing, and holding it back would only earn it an interruption of its
   * own a moment later.
   */
  const opensFlushAt = (item: MailboxItem): number =>
    item.kind === 'progress' ? lastProgressAt + timing.progressIntervalMs : Number.NEGATIVE_INFINITY

  /**
   * How long until this queue may go out — or null while the line is busy, in
   * which case no timer helps and the next state change is what re-arms.
   */
  const waitBeforeFlush = (now: number): number | null => {
    if (queue.length === 0) return null
    if (!syncQuiet(now)) return null
    const settle = queue.some((item) => item.priority >= URGENT_PRIORITY) ? timing.urgentSettleMs : timing.settleMs
    const soonest = Math.min(...queue.map(opensFlushAt))
    return Math.max(
      0,
      quietSince + settle - now,
      lastDeliveryAt + timing.afterDeliveryMs - now,
      soonest - now,
    )
  }

  const arm = () => {
    // While a delivery is in flight nothing else may be scheduled: the
    // in-flight one is the speech a second delivery would cancel. `flush`
    // re-arms when it settles.
    if (closed || delivering) return
    const wait = waitBeforeFlush(Date.now())
    clearTimer()
    if (wait === null) return
    timer = setTimeout(fire, wait)
  }

  const fire = () => {
    timer = null
    if (closed || delivering) return
    const now = Date.now()
    const wait = waitBeforeFlush(now)
    // The line went busy between arming and firing — which is the ordinary
    // case, because the agent started talking. Wait for the next boundary.
    if (wait === null) return
    if (wait > 0) {
      timer = setTimeout(fire, wait)
      return
    }
    flush(now)
  }

  const flush = (now: number) => {
    // The whole queue, always: by the time a flush fires, something in it has
    // earned the interruption, and everything else may as well be said in the
    // same breath rather than earning one of its own.
    const going = queue.splice(0, queue.length)
    if (going.some((item) => item.kind === 'progress')) lastProgressAt = now
    delivering = true
    // One message, not a burst — the point of coalescing. One line each,
    // because these are separate facts and running them into a paragraph is
    // how a status note ends up read out as a sentence.
    const delivery: MailboxDelivery = { text: going.map((item) => item.text).join('\n'), items: going }
    void (async () => {
      try {
        // Marked as said only once it HAS been said. Marking first was how a
        // caller ended up waiting 46 seconds for an answer that was already
        // finished: the model leg errored, the delivery produced no words, and
        // the queue had already thrown the item away — so nothing tried again,
        // and the caller sat in silence until they asked "did you find it?".
        const outcome = await options.deliver(delivery)
        const spoke = outcome ? outcome.spoke : true
        for (const item of going) {
          if (spoke) {
            said.add(identity(item))
            decide('delivered', item, 'said at a quiet boundary')
            continue
          }
          const attempts = (item.attempts ?? 0) + 1
          if (attempts >= MAX_DELIVERY_ATTEMPTS) {
            decide('dropped', item, `nothing was said on ${attempts} attempts — the model leg is not answering`)
            continue
          }
          // Back on the queue, in front: it was next before, and being unlucky
          // with the model does not put it behind newer news.
          queue.unshift({ ...item, attempts })
          decide('posted', item, `nothing was said, so it waits for the next quiet moment (attempt ${attempts})`)
        }
      } catch (error) {
        fail(`a delivery was not made: ${String(error)}`)
      } finally {
        // Stamped when the delivery is over rather than when it started, so
        // the floor is measured from the words actually being out of the way.
        lastDeliveryAt = Date.now()
        delivering = false
        arm()
      }
    })()
  }

  /**
   * The queue's rules, all four of them, in one place.
   *
   * `alreadySaid` marks a line the caller is being told by another route: it
   * runs every rule and is then stamped as told instead of queued — and retires
   * a copy of itself that was already waiting, which is the difference between
   * the caller hearing one sentence and hearing it twice. `route` names who is
   * saying it, for the record.
   */
  const enqueue = (input: MailboxPost, alreadySaid: boolean, route?: string) => {
    const text = input.text.trim()
    if (closed) {
      if (text) decide('dropped', { ...input, text }, 'the call had already ended')
      return
    }
    // A result retires its work before anything else is decided, so progress
    // that arrives after the answer is dropped rather than queued behind it.
    if (input.kind === 'result') finished.add(input.workId)

    if (!text) return
    const item: MailboxItem = {
      kind: input.kind,
      text,
      workId: input.workId,
      priority: input.priority ?? DELIVERY_PRIORITY[input.kind],
      postedAt: Date.now(),
    }
    const key = identity(item)
    // Deduplication. The same words about the same work, twice, is the agent
    // repeating itself — which reads as a stuck line, not as emphasis.
    if (said.has(key)) {
      decide('dropped', item, 'the caller has already been told this')
      return
    }
    const waiting = queue.findIndex((queued) => identity(queued) === key)
    if (waiting >= 0) {
      if (!alreadySaid) {
        decide('dropped', item, 'the same words are already waiting to be said')
        return
      }
      // The words are queued AND something else is about to say them. This is
      // the byte-identical repeat two seconds apart: the mailbox delivered the
      // approval line at a boundary and the tool's own return value said it
      // again at the turn tail. Retire the queued copy — one route is enough.
      queue.splice(waiting, 1)
      said.add(key)
      decide('delivered', item, route ?? 'said by another route')
      return
    }

    if (item.kind === 'progress') {
      // Coalescing, and the whole of what makes progress droppable: the work
      // is over, or a newer note about it is already waiting. Only the newest
      // matters — nobody wants to hear where it was two steps ago.
      if (finished.has(item.workId)) {
        decide('dropped', item, 'the answer for this work has already landed')
        return
      }
      const stale = queue.findIndex((queued) => queued.kind === 'progress' && queued.workId === item.workId)
      if (stale >= 0) {
        decide('coalesced', queue[stale]!, `superseded by a newer note about the same work: ${item.text}`)
        queue.splice(stale, 1)
      }
    } else {
      // An answer, an approval or a failure is the current state of that work.
      // "Still reading the site" behind it would be a lie. These never
      // supersede each other, and they are never dropped.
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const queued = queue[index]!
        if (queued.kind === 'progress' && queued.workId === item.workId) {
          decide('coalesced', queued, `superseded by the ${item.kind} for the same work`)
          queue.splice(index, 1)
        }
      }
    }

    if (alreadySaid) {
      said.add(key)
      decide('delivered', item, route ?? 'said by another route')
      return
    }
    queue.push(item)
    decide('posted', item)
    arm()
  }

  return {
    post: (item) => enqueue(item, false),
    delivered: (item) => enqueue(item, true, "said by the tool's own reply"),
    // A copy: the queue is spliced under the caller's feet by every flush, and
    // an inspector holding the live array would report a queue that emptied
    // itself while it was being read.
    pending: () => [...queue],
    acknowledge: () => {
      const taken = queue.splice(0, queue.length)
      for (const item of taken) {
        said.add(identity(item))
        decide('delivered', item, 'handed to the model when it asked where things stood')
      }
      clearTimer()
      // Deliberately not stamping `lastProgressAt`: nothing was spoken, so
      // nothing was spent from the caller's patience. The rate limit governs
      // what the caller hears, not what the model reads.
      return taken
    },
    notifyStateChanged: () => {
      if (closed) return
      if (!syncQuiet(Date.now())) {
        // The line went busy. A flush already armed must not fire into it.
        clearTimer()
        return
      }
      arm()
    },
    close: () => {
      if (closed) return
      closed = true
      clearTimer()
      // What was still waiting when the line went down is a thing the caller
      // was owed and never heard. Say so on the way out rather than dropping it
      // silently: this is the only record that it existed at all.
      for (const item of queue.splice(0, queue.length)) {
        decide('dropped', item, 'the call ended before this could be said')
      }
    },
  }
}
