/**
 * The call's operational record: why the agent said each thing, and what
 * became of every piece of work.
 *
 * A call already leaves two ledgers — the turns it spoke and the events its
 * work produced — and neither one says *why*. Three defects were misdiagnosed
 * twice each because of it: an answer the agent had and never spoke looked
 * exactly like an answer it never got; two identical lines in `call_turns`
 * looked exactly like one line recorded twice; and an approval the caller was
 * never told about left nothing behind at all. None of those can be settled by
 * reading the transcript, because the transcript is the symptom.
 *
 * So every utterance and every piece of work leaves one more row on the run's
 * own event ledger — kind `trace` — naming its cause and its fate. It is an
 * operational record, not telemetry: a handful of flat, greppable fields per
 * fact, no timings, no counters, no sampling. The one question it exists to
 * answer in a single query is "was this work's answer ever spoken?":
 *
 *     select seq, payload->>'trace', payload->>'workId', payload->>'answer'
 *       from run_events
 *      where kind = 'trace' and payload->>'trace' like 'work_%'
 *      order by seq;
 *
 * Two rules keep it honest. Nothing here derives a fact it was not told — a
 * turn's cause is whatever the process actually did to produce it, never a
 * guess from the words. And no picture ever reaches this ledger: `plain()`
 * strips data URLs, because a single base-64 frame in a payload makes the whole
 * record unreadable and unqueryable (which is why `takeAbilityFrame` exists on
 * every other path a tool result travels).
 *
 * Framework-free on purpose — it imports nothing from @livekit/agents and
 * nothing from the database, so the whole of it is testable without a call.
 * Imported by the voice agent process and its test; the web app never bundles
 * it.
 */

/** The ledger kinds the trace writes. `error` is for what must not be missed. */
export type TraceSink = (kind: 'trace' | 'error', payload: Record<string, unknown>) => void

/**
 * Why the agent is about to speak, or just spoke.
 *
 * `spontaneous` is the interesting one: an utterance nothing asked for. It is
 * how "the model answered from stale context" is told apart from "the model
 * read out the answer it was given", which is the whole of defect 4.
 */
export type TurnCause =
  | { cause: 'caller_turn'; callerItemId: string }
  | { cause: 'mailbox_delivery'; workIds: string[]; deliveryKinds: string[] }
  | { cause: 'work_result'; workId: string }
  | { cause: 'greeting' }
  | { cause: 'vision_lost' }
  /**
   * The line had been quiet too long while work was still running, so one of a
   * fixed set of contentless lines was said straight through the mouth. Never
   * generated: the version that asked the model for "one short line of
   * company" spoke a phishing message at a caller on its only firing.
   */
  | { cause: 'filler' }
  | { cause: 'spontaneous' }

/** How a piece of work ended, in the words the worker uses for it. */
export type WorkTraceStatus = 'working' | 'done' | 'needs_approval' | 'failed' | 'stopped'

/** One decision the mailbox made about one line, and why. */
export type MailboxTraceDecision = {
  decision: 'posted' | 'coalesced' | 'dropped' | 'delivered'
  /** The DeliveryKind, as a string — the trace does not need the union. */
  kind: string
  workId: string
  text: string
  /** Why it was coalesced, dropped, or how it was delivered. */
  reason?: string
}

/** A turn expectation, held until the utterance it is waiting for arrives. */
export type TurnExpectation = {
  /**
   * Give up on it. Called when the speech that was asked for has finished
   * without producing an utterance — a model told it may say nothing sometimes
   * says nothing — so the expectation cannot be mis-attributed to whatever the
   * agent says next.
   *
   * Returns whether anything was in fact said. A caller does not distinguish
   * between "the agent chose not to speak" and "the model errored and no words
   * came out"; both are silence on the line, and whoever asked for the speech
   * needs to know which it got.
   */
  release: (options?: {
    /**
     * False when the caller will immediately use a deterministic speech
     * fallback. The expectation is still released, but silence is not written
     * as a fault unless that final route is silent too.
     */
    recordUnspoken?: boolean
  }) => { spoke: boolean }
}

export type CallTrace = {
  /**
   * A final transcript arrived off the caller's audio, whatever becomes of it.
   * This is the ground truth for "the agent ignored me": a caller once spoke
   * into two minutes of working silence and the record could not say whether
   * their words never reached the transcriber or reached it and were not
   * answered — two entirely different faults with identical transcripts.
   */
  heard: (line: { text: string }) => void
  /** The caller said something. The next agent turn is probably an answer to it. */
  callerTurn: (itemId: string) => void
  /**
   * The process is about to make the agent speak, and this is why. A work
   * result outranks everything else waiting: the framework guarantees a reply
   * once an async tool returns, so that reply is the answer being read out.
   */
  expectTurn: (cause: TurnCause) => TurnExpectation
  /**
   * The agent said something. Returns whether this exact chat item has already
   * been recorded — which is the only safe basis for skipping a transcript
   * insert. Identical *words* under a new id are a genuine second utterance and
   * are recorded, flagged, and left in the transcript, because they happened.
   */
  agentTurn: (item: { itemId: string; text: string }) => { alreadyRecorded: boolean }
  /** Work handed to the worker, with the intent it was handed over as. */
  handedOver: (work: { workId: string; intent: string }) => void
  /** Work settled — this is the answer that exists, whoever ends up hearing it. */
  settled: (work: { workId: string; status: WorkTraceStatus; answer: string; seconds: number }) => void
  /**
   * The caller has heard this answer by a route other than the reply to the
   * tool's return value — the mailbox said the same words at a quiet boundary
   * while the work was still running. Recorded, or the close-out would call an
   * answer the caller demonstrably heard one they never got, and an accounting
   * that cries wolf is one nobody reads.
   */
  answerAlreadySpoken: (work: { workId: string; route: string }) => void
  /**
   * Work that outlived the call, refiled through the deferred disposition (or
   * not, and then plainly why not).
   */
  deferred: (work: { workId: string; refiled: boolean; reason: string; assignmentId?: string }) => void
  /** One mailbox decision. */
  mailbox: (decision: MailboxTraceDecision) => void
  /** Which route this call has for reading a page, and why it has that one. */
  pageAccess: (access: { route: string; reason: string }) => void
  /**
   * The call is over. Every answer that exists and was never spoken is written
   * down here as an error, because an answer produced and never delivered is
   * the failure a caller actually experiences and it must be impossible to miss.
   */
  close: () => void
}

/** How much of any one line the record keeps. The full text lives in `call_turns`. */
const TEXT_CAP = 400

/**
 * A string fit for the ledger: one line, bounded, and with any embedded image
 * stripped. A data URL in a payload is tens of thousands of characters of
 * base-64 that make every query against this table useless — the same reason
 * `takeAbilityFrame` pulls frames out before a tool result is ever serialized.
 */
export function plain(value: string): string {
  const withoutImages = value.replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, '[image]')
  const oneLine = withoutImages.replace(/\s+/g, ' ').trim()
  return oneLine.length > TEXT_CAP ? `${oneLine.slice(0, TEXT_CAP - 1)}…` : oneLine
}

export function createCallTrace(sink: TraceSink): CallTrace {
  /** What we have said, by chat item id — the basis of the duplicate check. */
  const spokenItems = new Map<string, string>()
  /** The same words, to the id that first said them. Never used to skip a row. */
  const wordsFirstSaidBy = new Map<string, string>()

  type WorkState = {
    intent: string
    status: WorkTraceStatus
    /** The answer the work produced, if it produced one. */
    answer: string
    /** The chat item the answer was spoken in, once it has been. */
    spokenIn: string | null
    /** The assignment it was refiled as, once the call ended under it. */
    refiledAs: string | null
  }
  const work = new Map<string, WorkState>()

  /**
   * Turn expectations, newest last. A work result is taken before anything
   * else because the framework's async-tool path always makes a reply for it;
   * everything else is taken in the order it was asked for.
   */
  let expectations: { cause: TurnCause; live: boolean }[] = []
  let callerTurnPending: string | null = null
  let closed = false

  const write = (payload: Record<string, unknown>) => {
    sink('trace', payload)
  }

  const takeCause = (): TurnCause => {
    const live = expectations.filter((entry) => entry.live)
    const chosen = live.find((entry) => entry.cause.cause === 'work_result') ?? live[0]
    if (chosen) {
      chosen.live = false
      expectations = expectations.filter((entry) => entry.live)
      return chosen.cause
    }
    if (callerTurnPending !== null) {
      const callerItemId = callerTurnPending
      callerTurnPending = null
      return { cause: 'caller_turn', callerItemId }
    }
    return { cause: 'spontaneous' }
  }

  return {
    heard: ({ text }) => {
      write({ trace: 'stt', chars: text.length, words: plain(text) })
    },
    callerTurn: (itemId) => {
      callerTurnPending = itemId
    },
    expectTurn: (cause) => {
      const entry = { cause, live: true }
      expectations.push(entry)
      return {
        // Whether the agent actually said anything for this expectation. An
        // agent turn consumes the expectation (`takeCause` clears `live`), so
        // one still live at release is one that produced silence — which the
        // caller in a real call experienced as the agent ignoring them.
        release: (options): { spoke: boolean } => {
          if (!entry.live) return { spoke: true }
          entry.live = false
          expectations = expectations.filter((held) => held.live)
          if (options?.recordUnspoken === false) return { spoke: false }
          // A delivery that produced no words at all is worth a line of its
          // own: it is exactly how a caller ends up never hearing that
          // something needs their sign-off, and there is no other trace of it.
          if (entry.cause.cause !== 'mailbox_delivery') return { spoke: false }
          const { workIds, deliveryKinds } = entry.cause
          write({ trace: 'delivery_unspoken', workIds, deliveryKinds })
          if (deliveryKinds.includes('needs_approval')) {
            sink('error', {
              message: `The caller was not told that something needs their sign-off: the delivery was made at a quiet moment and the agent said nothing (${workIds.join(', ')}).`,
            })
          }
          return { spoke: false }
        },
      }
    },
    agentTurn: ({ itemId, text }) => {
      const words = plain(text)
      const already = spokenItems.has(itemId)
      if (already) {
        // The same chat item arriving twice is the ledger double-recording one
        // utterance, not the agent saying it twice. Provable, and now visible.
        write({ trace: 'turn', itemId, cause: 'repeat_of_recorded_item', chars: text.length, words })
        return { alreadyRecorded: true }
      }
      const cause = takeCause()
      const firstSaidBy = wordsFirstSaidBy.get(words)
      spokenItems.set(itemId, words)
      if (!firstSaidBy) wordsFirstSaidBy.set(words, itemId)
      write({
        trace: 'turn',
        itemId,
        ...cause,
        chars: text.length,
        words,
        // Two ids, one set of words: the agent genuinely said the same thing
        // twice. The cause on each row is what says which two routes did it.
        ...(firstSaidBy ? { sameWordsAs: firstSaidBy } : {}),
      })
      if (cause.cause === 'work_result') {
        const state = work.get(cause.workId)
        if (state) state.spokenIn = itemId
        write({ trace: 'work_answer_spoken', workId: cause.workId, itemId })
      }
      return { alreadyRecorded: false }
    },
    handedOver: ({ workId, intent }) => {
      work.set(workId, { intent: plain(intent), status: 'working', answer: '', spokenIn: null, refiledAs: null })
      write({ trace: 'work_handed_over', workId, intent: plain(intent) })
    },
    settled: ({ workId, status, answer, seconds }) => {
      const state = work.get(workId) ?? {
        intent: '',
        status: 'working' as WorkTraceStatus,
        answer: '',
        spokenIn: null,
        refiledAs: null,
      }
      state.status = status
      // Only a finished answer counts as one. A failure or a park has words
      // too, but nobody is owed them the way they are owed the answer.
      state.answer = status === 'done' ? plain(answer) : ''
      work.set(workId, state)
      write({
        trace: 'work_settled',
        workId,
        status,
        seconds,
        answer: plain(answer),
        hasAnswer: state.answer.length > 0,
      })
      // Settling *after* the call is already accounted for is the narrow race
      // this defect actually happened in: the answer landed a moment after the
      // line went down. The accounting has already run, so it happens here
      // instead — an answer nobody heard must not be quietly missing from the
      // one place it would be looked for.
      if (closed && state.answer && !state.spokenIn) {
        write({
          trace: 'work_answer_undelivered',
          workId,
          status,
          answer: state.answer,
          reason: 'the answer landed after the call had ended',
          ...(state.refiledAs ? { refiledAs: state.refiledAs } : {}),
        })
        if (!state.refiledAs) {
          sink('error', {
            message: `This work produced an answer the caller never heard (${workId}): ${state.answer}`,
          })
        }
      }
    },
    answerAlreadySpoken: ({ workId, route }) => {
      const state = work.get(workId)
      if (state) state.spokenIn = `route:${route}`
      write({ trace: 'work_answer_spoken', workId, route })
    },
    deferred: ({ workId, refiled, reason, assignmentId }) => {
      const state = work.get(workId)
      if (state && assignmentId) state.refiledAs = assignmentId
      write({
        trace: 'work_deferred',
        workId,
        refiled,
        reason,
        ...(assignmentId ? { assignmentId } : {}),
      })
      if (!refiled) {
        sink('error', {
          message: `Work the caller was waiting on outlived the call and could not be refiled to finish afterwards (${workId}): ${reason}`,
        })
      }
    },
    mailbox: (decision) => {
      write({
        trace: 'mailbox',
        decision: decision.decision,
        kind: decision.kind,
        workId: decision.workId,
        text: plain(decision.text),
        ...(decision.reason ? { reason: decision.reason } : {}),
      })
    },
    pageAccess: (access) => {
      write({
        trace: 'page_access',
        route: access.route,
        reason: access.reason,
      })
    },
    close: () => {
      if (closed) return
      closed = true
      for (const [workId, state] of work) {
        if (state.spokenIn) continue
        if (state.answer) {
          // The whole of defect 4, caught the moment it happens instead of
          // being reconstructed from a transcript weeks later.
          write({
            trace: 'work_answer_undelivered',
            workId,
            status: state.status,
            answer: state.answer,
            ...(state.refiledAs ? { refiledAs: state.refiledAs } : {}),
          })
          if (state.refiledAs) continue
          sink('error', {
            message: `This work produced an answer the caller never heard (${workId}): ${state.answer}`,
          })
          continue
        }
        if (state.status === 'working' && !state.refiledAs) {
          write({
            trace: 'work_answer_undelivered',
            workId,
            status: 'stopped',
            answer: '',
            reason: 'the call ended before the work settled, and it was not refiled to finish afterwards',
          })
        }
      }
    },
  }
}
