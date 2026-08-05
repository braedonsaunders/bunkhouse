import assert from 'node:assert/strict'
import {
  createCallMailbox,
  type MailboxDecision,
  type MailboxDelivery,
  type MailboxTiming,
} from '../src/lib/call-mailbox'
import { resolvePageAccess, toolsPromisedButAbsent } from '../src/lib/call-reading'
import { createCallTrace } from '../src/lib/call-trace'
import { describeToolCall, toolActivityFromEvents } from '../src/lib/call-activity'
import { approvalCompletion, settledWorkPost, spokenWorkResult } from '../src/lib/call-speech'

/**
 * What a call says, and why — the three framework-free modules the talker
 * stands on.
 *
 * The delivery mailbox exists because of one bug: anything the worker said
 * reached the caller as a fresh reply and cut off the speech already in their
 * ear. Every rule here is one half of that fix — hold until the line is quiet,
 * then say everything waiting once. Beside it, the trace (why the agent spoke,
 * and what became of each piece of work) and the page-reading rule (never leave
 * the worker with no way to read a page), both of which exist because a defect
 * could not be diagnosed from the transcript alone.
 *
 * The mailbox takes its delays as a parameter precisely so this file can run
 * in milliseconds instead of the twenty seconds a real call's rate limit
 * spans. Everything else — the queue, the clock, the callbacks — is the real
 * thing; nothing here is a stand-in for the module under test.
 */

/** The call's delays, divided by about a hundred. */
const FAST: MailboxTiming = {
  settleMs: 20,
  urgentSettleMs: 5,
  progressIntervalMs: 200,
  afterDeliveryMs: 30,
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// An approved action stays the same activity item from request through
// execution. This is the event order from a real call: filing approval parks
// the tool, and the executor later reports success against the approval id.
{
  const activity = toolActivityFromEvents([
    {
      seq: 150,
      kind: 'tool_call',
      atMs: 12_000,
      payload: { toolName: 'send_email', input: { to: 'bsaunders@rassaun.com' } },
    },
    {
      seq: 151,
      kind: 'approval_request',
      atMs: 13_000,
      payload: { toolName: 'send_email', approvalId: 'approval-1' },
    },
    {
      seq: 158,
      kind: 'tool_result',
      atMs: 30_000,
      payload: {
        toolName: 'send_email',
        approvedApprovalId: 'approval-1',
        output: { sent: true, to: 'bsaunders@rassaun.com' },
      },
    },
  ])
  assert.equal(activity.length, 1)
  assert.equal(activity[0]!.status, 'done', 'the approved result completes the item that was parked')
  assert.equal(activity[0]!.detail, null)
}

// Machine-facing integration names never leak into speech or the operator's
// live activity list.
assert.equal(describeToolCall('netsuite_ns_runCustomSuiteQL', {}), 'Checking NetSuite')

// A long written report becomes its final spoken conclusion, not a markdown
// table read cell-by-cell or an unbounded monologue.
{
  const report = [
    '# Deposit detail',
    '',
    '| Customer | Amount |',
    '| --- | ---: |',
    '| Acme | $12.00 |',
    '',
    'I created the August 4 deposit-detail PDF and sent it to bsaunders@rassaun.com and ksaunders@rassaun.com. Both messages include the finished attachment.',
  ].join('\n')
  const spoken = spokenWorkResult(report)
  assert.ok(!spoken.includes('|'), 'tables stay on the screen')
  assert.match(spoken, /^I created/)
  assert.ok(spoken.split(/\s+/).length <= 55, 'one call turn stays bounded')

  assert.equal(
    settledWorkPost({
      id: 'work-1',
      intent: 'send the report',
      status: 'needs_approval',
      detail: 'Approval request emailed.',
      runningForSeconds: 12,
    }),
    null,
    'the worker does not post a queued approval again as a finished result',
  )
  assert.deepEqual(
    approvalCompletion('send_email', {
      sent: true,
      to: 'bsaunders@rassaun.com, ksaunders@rassaun.com',
      attachedFiles: 1,
    }),
    {
      text: 'The email to bsaunders@rassaun.com, ksaunders@rassaun.com has been approved and sent with the attachment. Is there anything else you need?',
      failed: false,
    },
  )
  assert.deepEqual(approvalCompletion('send_email', { sent: false, reason: 'The mailbox rejected it.' }), {
    text: 'That was approved, but it still could not be completed: The mailbox rejected it.',
    failed: true,
  })
}

/** A line the mailbox is watching, and what it has been told to say. */
function harness(timing: Partial<MailboxTiming> = {}) {
  const delivered: MailboxDelivery[] = []
  const decisions: MailboxDecision[] = []
  let quiet = true
  const mailbox = createCallMailbox({
    isQuiet: () => quiet,
    deliver: async (delivery) => {
      delivered.push(delivery)
    },
    onDecision: (decision) => decisions.push(decision),
    timing: { ...FAST, ...timing },
    onError: (message) => assert.fail(`the mailbox reported an error: ${message}`),
  })
  return {
    mailbox,
    delivered,
    decisions,
    /** What the caller has actually heard, in order. */
    heard: () => delivered.map((delivery) => delivery.text),
    /** Every decision about one line, as `decision:reason`. */
    about: (text: string) =>
      decisions
        .filter((decision) => decision.text === text)
        .map((decision) => `${decision.decision}${decision.reason ? `:${decision.reason}` : ''}`),
    setQuiet: (value: boolean) => {
      quiet = value
      mailbox.notifyStateChanged()
    },
  }
}

// --- coalescing -------------------------------------------------------------
// Four things happening in the second before a boundary is one thing to say,
// not four replies each cancelling the last.
{
  const line = harness()
  line.mailbox.post({ kind: 'progress', workId: 'work-1', text: 'Searching the web' })
  line.mailbox.post({ kind: 'progress', workId: 'work-2', text: 'Reading example.com' })
  line.mailbox.post({ kind: 'needs_approval', workId: 'work-3', text: 'Sending email to dana@example.com — it needs a sign-off.' })
  assert.equal(line.delivered.length, 0, 'nothing goes out before the line has settled')
  assert.equal(line.mailbox.pending().length, 3)

  await sleep(60)
  assert.equal(line.delivered.length, 1, 'one boundary, one message')
  assert.equal(line.delivered[0]!.items.length, 3, 'all three rode along')
  assert.match(line.heard()[0]!, /Searching the web/)
  assert.match(line.heard()[0]!, /Reading example\.com/)
  assert.match(line.heard()[0]!, /needs a sign-off/)
  assert.equal(line.mailbox.pending().length, 0, 'the queue is emptied by the flush')
  line.mailbox.close()
}

// Progress about the SAME work supersedes itself: only where it is up to now
// matters, never where it was two steps ago.
{
  const line = harness()
  line.mailbox.post({ kind: 'progress', workId: 'work-1', text: 'Opening example.com in the browser' })
  line.mailbox.post({ kind: 'progress', workId: 'work-1', text: 'Reading the page' })
  line.mailbox.post({ kind: 'progress', workId: 'work-1', text: 'Clicking “Availability”' })
  assert.equal(line.mailbox.pending().length, 1, 'one work, one pending line')
  assert.equal(line.mailbox.pending()[0]!.text, 'Clicking “Availability”')

  await sleep(60)
  assert.deepEqual(line.heard(), ['Clicking “Availability”'])
  line.mailbox.close()
}

// --- a result supersedes progress, and is never dropped ---------------------
// "Understood. I'm seeing..." arriving after the answer is the exact line from
// the transcript this module was written against.
{
  const line = harness()
  line.mailbox.post({ kind: 'progress', workId: 'work-1', text: 'Reading example.com' })
  line.mailbox.post({ kind: 'result', workId: 'work-1', text: 'They open at nine on the Monday holiday.' })
  assert.deepEqual(
    line.mailbox.pending().map((item) => item.text),
    ['They open at nine on the Monday holiday.'],
    'the stale progress is discarded, the answer is not',
  )

  // Progress that turns up after the answer has already landed is stale too —
  // the work is over, and saying where it was is worse than saying nothing.
  line.mailbox.post({ kind: 'progress', workId: 'work-1', text: 'Reading the page' })
  assert.equal(line.mailbox.pending().length, 1, 'progress behind an answer is dropped')

  // Another work's progress is untouched: supersession is per piece of work.
  line.mailbox.post({ kind: 'progress', workId: 'work-2', text: 'Searching the web' })
  assert.equal(line.mailbox.pending().length, 2)

  await sleep(60)
  assert.equal(line.delivered.length, 1)
  assert.deepEqual(line.delivered[0]!.items.map((item) => item.kind), ['result', 'progress'])
  line.mailbox.close()
}

// A result the framework is speaking by another route still retires the work,
// and is never said twice.
{
  const line = harness()
  line.mailbox.post({ kind: 'progress', workId: 'work-1', text: 'Reading example.com' })
  line.mailbox.delivered({ kind: 'result', workId: 'work-1', text: 'They open at nine.' })
  assert.equal(line.mailbox.pending().length, 0, 'nothing is left to say about finished work')

  line.mailbox.post({ kind: 'result', workId: 'work-1', text: 'They open at nine.' })
  assert.equal(line.mailbox.pending().length, 0, 'the same answer never goes out a second time')

  await sleep(60)
  assert.deepEqual(line.heard(), [])
  line.mailbox.close()
}

// --- rate limiting ----------------------------------------------------------
// Progress is company, not information. Twice a minute on a real call; here,
// once per 200ms.
{
  const line = harness()
  line.mailbox.post({ kind: 'progress', workId: 'work-1', text: 'Searching the web' })
  await sleep(60)
  assert.deepEqual(line.heard(), ['Searching the web'])

  line.mailbox.post({ kind: 'progress', workId: 'work-2', text: 'Reading example.com' })
  await sleep(120)
  assert.equal(line.delivered.length, 1, 'a second progress line waits out the interval')
  assert.equal(line.mailbox.pending().length, 1, 'and stays queued rather than being lost')

  // An approval is not rate limited: it is worth breaking the silence for, and
  // it takes the waiting progress line along with it.
  line.mailbox.post({ kind: 'needs_approval', workId: 'work-3', text: 'That needs a sign-off.' })
  await sleep(60)
  assert.equal(line.delivered.length, 2)
  assert.deepEqual(line.delivered[1]!.items.map((item) => item.kind), ['progress', 'needs_approval'])
  line.mailbox.close()
}

// The queued progress does eventually go out once the interval has passed,
// even though no further event arrives to prompt it.
{
  const line = harness()
  line.mailbox.post({ kind: 'progress', workId: 'work-1', text: 'Searching the web' })
  await sleep(60)
  line.mailbox.post({ kind: 'progress', workId: 'work-2', text: 'Reading example.com' })
  await sleep(300)
  assert.deepEqual(line.heard(), ['Searching the web', 'Reading example.com'])
  line.mailbox.close()
}

// --- deduplication ----------------------------------------------------------
// The same words about the same work, twice, reads as a stuck line.
{
  const line = harness()
  line.mailbox.post({ kind: 'progress', workId: 'work-1', text: 'Reading example.com' })
  line.mailbox.post({ kind: 'progress', workId: 'work-1', text: 'Reading example.com' })
  assert.equal(line.mailbox.pending().length, 1, 'a duplicate is never queued twice')

  await sleep(60)
  assert.deepEqual(line.heard(), ['Reading example.com'])

  // Said once is said for good — the loop revisiting the same page later must
  // not make the agent repeat itself.
  line.mailbox.post({ kind: 'progress', workId: 'work-1', text: 'Reading example.com' })
  assert.equal(line.mailbox.pending().length, 0)
  await sleep(300)
  assert.equal(line.delivered.length, 1)

  // The same words about a DIFFERENT piece of work are a different fact.
  line.mailbox.post({ kind: 'progress', workId: 'work-2', text: 'Reading example.com' })
  await sleep(60)
  assert.equal(line.delivered.length, 2)
  line.mailbox.close()
}

// --- the boundary ----------------------------------------------------------
// The whole point: nothing is delivered while the agent is speaking, however
// urgent it is and however long it waits.
{
  const line = harness()
  line.setQuiet(false)
  line.mailbox.post({ kind: 'progress', workId: 'work-1', text: 'Reading example.com' })
  line.mailbox.post({ kind: 'failed', workId: 'work-2', text: 'That ran into trouble: the site refused us.' })
  await sleep(120)
  assert.deepEqual(line.heard(), [], 'not one word over the agent')
  assert.equal(line.mailbox.pending().length, 2, 'and nothing was lost waiting')

  // The moment the line goes quiet, and only then, both go out as one message.
  line.setQuiet(true)
  await sleep(60)
  assert.equal(line.delivered.length, 1)
  assert.equal(line.delivered[0]!.items.length, 2)
  line.mailbox.close()
}

// A boundary that closes again between arming and firing costs a wait, not an
// interruption: the agent starting a new sentence mid-settle cancels the flush.
{
  const line = harness()
  line.mailbox.post({ kind: 'progress', workId: 'work-1', text: 'Reading example.com' })
  await sleep(5)
  line.setQuiet(false)
  await sleep(120)
  assert.deepEqual(line.heard(), [], 'the settle delay is what catches this')
  line.setQuiet(true)
  await sleep(60)
  assert.deepEqual(line.heard(), ['Reading example.com'])
  line.mailbox.close()
}

// Two deliveries never run at once. The second waits for the first to be over,
// which on a call means waiting for its speech to finish playing out.
{
  const delivered: string[] = []
  let releaseFirst = () => {}
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let deliveries = 0
  const mailbox = createCallMailbox({
    isQuiet: () => true,
    deliver: async (delivery) => {
      deliveries += 1
      if (deliveries === 1) await first
      delivered.push(delivery.text)
    },
    timing: { ...FAST, progressIntervalMs: 0 },
    onError: (message) => assert.fail(`the mailbox reported an error: ${message}`),
  })

  mailbox.post({ kind: 'needs_approval', workId: 'work-1', text: 'That needs a sign-off.' })
  await sleep(30)
  assert.equal(deliveries, 1, 'the first delivery is under way')

  mailbox.post({ kind: 'failed', workId: 'work-2', text: 'That ran into trouble.' })
  await sleep(60)
  assert.equal(deliveries, 1, 'the second is held while the first is still being said')
  assert.equal(mailbox.pending().length, 1)

  releaseFirst()
  await sleep(80)
  assert.deepEqual(delivered, ['That needs a sign-off.', 'That ran into trouble.'])
  mailbox.close()
}

// A repeated approval that arrives while the first copy is physically being
// spoken is not waiting in the queue and is not yet in the said set. The
// in-flight identity is the only thing preventing a second utterance.
{
  const decisions: MailboxDecision[] = []
  let release = () => {}
  const playout = new Promise<void>((resolve) => {
    release = resolve
  })
  const mailbox = createCallMailbox({
    isQuiet: () => true,
    deliver: async () => playout,
    onDecision: (decision) => decisions.push(decision),
    timing: FAST,
  })
  const approval = { kind: 'needs_approval' as const, workId: 'work-1', text: 'The email needs a sign-off.' }
  mailbox.post(approval)
  await sleep(20)
  mailbox.post(approval)
  assert.equal(mailbox.pending().length, 0)
  assert.ok(
    decisions.some(
      (decision) => decision.text === approval.text && decision.reason === 'the same words are already being said',
    ),
  )
  release()
  await sleep(20)
  mailbox.close()
}

// --- check_work, and the end of the call ------------------------------------
// A model that has just asked where things stand is handed everything waiting,
// and is not then interrupted with what it has already read.
{
  const line = harness()
  line.setQuiet(false)
  line.mailbox.post({ kind: 'progress', workId: 'work-1', text: 'Reading example.com' })
  line.mailbox.post({ kind: 'progress', workId: 'work-2', text: 'Searching the web' })

  const taken = line.mailbox.acknowledge()
  assert.deepEqual(taken.map((item) => item.text), ['Reading example.com', 'Searching the web'])
  assert.equal(line.mailbox.pending().length, 0)

  line.setQuiet(true)
  await sleep(60)
  assert.deepEqual(line.heard(), [], 'acknowledged lines are never also spoken')
  line.mailbox.close()
}

// A closed mailbox says nothing and accepts nothing: the caller has hung up.
{
  const line = harness()
  line.mailbox.post({ kind: 'failed', workId: 'work-1', text: 'That ran into trouble.' })
  line.mailbox.close()
  line.mailbox.post({ kind: 'result', workId: 'work-2', text: 'They open at nine.' })
  await sleep(80)
  assert.deepEqual(line.heard(), [])
  assert.equal(line.mailbox.pending().length, 0)
  // What was still waiting when the line went down was owed to the caller and
  // never said. The record is the only place that survives.
  assert.deepEqual(line.about('That ran into trouble.'), [
    'posted',
    'dropped:the call ended before this could be said',
  ])
  assert.deepEqual(line.about('They open at nine.'), ['dropped:the call had already ended'])
}

// --- the decisions, on the record -------------------------------------------
// Every rule above exists to NOT say something, so each one has to say why.
// Without this, an approval the caller needed and an approval they were spared
// leave the same trace behind — none.
{
  const line = harness()
  line.mailbox.post({ kind: 'progress', workId: 'work-1', text: 'Opening example.com in the browser' })
  line.mailbox.post({ kind: 'progress', workId: 'work-1', text: 'Reading the page' })
  line.mailbox.post({ kind: 'progress', workId: 'work-1', text: 'Reading the page' })
  assert.deepEqual(line.about('Opening example.com in the browser'), [
    'posted',
    'coalesced:superseded by a newer note about the same work: Reading the page',
  ])
  assert.deepEqual(line.about('Reading the page'), [
    'posted',
    'dropped:the same words are already waiting to be said',
  ])

  await sleep(60)
  assert.deepEqual(line.about('Reading the page'), [
    'posted',
    'dropped:the same words are already waiting to be said',
    'delivered:said at a quiet boundary',
  ])

  // And the one that matters most: an approval coalescing progress away is a
  // deliberate decision, recorded as one.
  line.mailbox.post({ kind: 'progress', workId: 'work-2', text: 'Sending the email' })
  line.mailbox.post({ kind: 'needs_approval', workId: 'work-2', text: 'Sending email to dana@example.com — sign-off needed.' })
  assert.deepEqual(line.about('Sending the email'), [
    'posted',
    'coalesced:superseded by the needs_approval for the same work',
  ])
  line.mailbox.close()
}

// The model asking where things stand is a delivery of its own, and says so.
{
  const line = harness()
  line.setQuiet(false)
  line.mailbox.post({ kind: 'progress', workId: 'work-1', text: 'Searching the web' })
  line.mailbox.acknowledge()
  assert.deepEqual(line.about('Searching the web'), [
    'posted',
    'delivered:handed to the model when it asked where things stood',
  ])
  line.mailbox.close()
}

// --- one mouth: the answer goes out once, by the only route there is -------
// The duplicate-utterance defect, at its root. There used to be two routes to
// the caller — the mailbox at a quiet boundary, and `do_work`'s return value
// at the turn tail — and two routes that each believed they were the only one
// is how the identical sentence landed twice, seconds apart, in call_turns.
// The referee that used to arbitrate between them is gone because there is
// nothing left to arbitrate: an answer is posted like every other fact.
{
  const line = harness()
  const parked = 'Opening example.com in the browser — it needs a manager’s sign-off before it can happen.'
  const answer = 'The Travelodge has rooms tomorrow night at 189 dollars.'

  // A parked line and, later, the answer to the same work. Both are posts;
  // neither is spoken by anything but the mailbox.
  line.mailbox.post({ kind: 'needs_approval', workId: 'work-1', text: parked })
  line.mailbox.post({ kind: 'result', workId: 'work-1', text: answer })
  await sleep(80)

  const heard = line.heard()
  assert.equal(heard.length, 1, 'everything waiting at one boundary is said once, together')
  assert.ok(heard[0]!.includes(answer), 'the answer is said')
  assert.ok(!heard[0]!.includes(parked), 'the completed action supersedes the stale approval line')

  // Posting the same answer again — a retry, a second settle, any route at all
  // — cannot produce a second utterance.
  line.mailbox.post({ kind: 'result', workId: 'work-1', text: answer })
  await sleep(80)
  assert.equal(line.heard().length, 1, 'the same words about the same work are never said twice')
  line.mailbox.close()
}

// --- the trace: why the agent spoke ----------------------------------------
// The transcript says what was said; nothing said why, and that is how "the
// model spoke twice" and "the ledger recorded one utterance twice" came to be
// confused for each other. The rule: dedupe on the chat item's id, never on
// text — identical words under two ids are two real utterances a caller heard
// twice, and hiding one of them destroys the evidence.
{
  const written: { kind: string; payload: Record<string, unknown> }[] = []
  const trace = createCallTrace((kind, payload) => written.push({ kind, payload }))
  const turns = () => written.filter((row) => row.payload.trace === 'turn').map((row) => row.payload)

  trace.callerTurn('item-caller-1')
  const first = trace.agentTurn({ itemId: 'item-1', text: 'They open at nine on the Monday holiday.' })
  assert.equal(first.alreadyRecorded, false)
  assert.equal(turns()[0]!.cause, 'caller_turn')
  assert.equal(turns()[0]!.callerItemId, 'item-caller-1')

  // The SAME chat item again: this is the ledger double-recording one
  // utterance. It must not reach the transcript twice.
  const repeat = trace.agentTurn({ itemId: 'item-1', text: 'They open at nine on the Monday holiday.' })
  assert.equal(repeat.alreadyRecorded, true, 'one chat item is one transcript row, for ever')
  assert.equal(turns()[1]!.cause, 'repeat_of_recorded_item')

  // The same WORDS under a new id: the agent genuinely said it twice. It is
  // recorded, it is flagged, and it is not suppressed.
  const again = trace.agentTurn({ itemId: 'item-2', text: 'They open at nine on the Monday holiday.' })
  assert.equal(again.alreadyRecorded, false, 'a second real utterance is never hidden by its words')
  assert.equal(turns()[2]!.sameWordsAs, 'item-1', 'and the pair is provable from the record')
  assert.equal(turns()[2]!.cause, 'spontaneous', 'nothing asked for it — which is itself the finding')
}

// An answer that came back and was never spoken is the loudest thing in the
// record, and an answer that was spoken is retired quietly.
{
  const written: { kind: string; payload: Record<string, unknown> }[] = []
  const trace = createCallTrace((kind, payload) => written.push({ kind, payload }))

  trace.handedOver({ workId: 'work-1', intent: 'find the three nearest suppliers' })
  trace.settled({ workId: 'work-1', status: 'done', answer: 'Three of them, all within ten miles.', seconds: 12 })
  trace.handedOver({ workId: 'work-2', intent: 'check whether they are open Monday' })
  trace.settled({ workId: 'work-2', status: 'done', answer: 'They open at nine.', seconds: 9 })

  // work-2's answer is read out; work-1's never is.
  trace.expectTurn({ cause: 'work_result', workId: 'work-2' })
  trace.agentTurn({ itemId: 'item-9', text: 'They open at nine, so you are fine.' })
  assert.ok(
    written.some((row) => row.payload.trace === 'work_answer_spoken' && row.payload.workId === 'work-2'),
    'the answer the caller heard is recorded as heard',
  )

  trace.close()
  const undelivered = written.filter((row) => row.payload.trace === 'work_answer_undelivered')
  assert.deepEqual(
    undelivered.map((row) => row.payload.workId),
    ['work-1'],
    'exactly the answer nobody heard',
  )
  assert.equal(
    undelivered[0]!.payload.answer,
    'Three of them, all within ten miles.',
    'with the answer itself, so it is not lost',
  )
  assert.ok(
    written.some((row) => row.kind === 'error' && String(row.payload.message).includes('never heard')),
    'and it is an error, because that is what the caller experienced',
  )
}

// An answer the mailbox already said is not an answer nobody heard. An
// accounting that cries wolf on a working call is one nobody reads.
{
  const written: { kind: string; payload: Record<string, unknown> }[] = []
  const trace = createCallTrace((kind, payload) => written.push({ kind, payload }))
  trace.handedOver({ workId: 'work-1', intent: 'send the quote to dana' })
  trace.settled({ workId: 'work-1', status: 'done', answer: 'It needs a sign-off first.', seconds: 4 })
  trace.answerAlreadySpoken({ workId: 'work-1', route: 'the mailbox said these words at a quiet boundary' })
  trace.close()
  assert.ok(written.some((row) => row.payload.trace === 'work_answer_spoken' && row.payload.route))
  assert.equal(written.filter((row) => row.payload.trace === 'work_answer_undelivered').length, 0)
  assert.equal(written.filter((row) => row.kind === 'error').length, 0)
}

// Work the call ended underneath, refiled to finish afterwards: the answer is
// late rather than missing, and the record says which.
{
  const written: { kind: string; payload: Record<string, unknown> }[] = []
  const trace = createCallTrace((kind, payload) => written.push({ kind, payload }))
  trace.handedOver({ workId: 'work-1', intent: 'compare their prices' })
  trace.deferred({ workId: 'work-1', refiled: true, reason: 'refiled as an assignment', assignmentId: 'a-1' })
  trace.close()
  assert.equal(
    written.filter((row) => row.kind === 'error').length,
    0,
    'work with somewhere to go is not a failure',
  )

  const stranded: { kind: string; payload: Record<string, unknown> }[] = []
  const second = createCallTrace((kind, payload) => stranded.push({ kind, payload }))
  second.handedOver({ workId: 'work-1', intent: 'compare their prices' })
  second.deferred({ workId: 'work-1', refiled: false, reason: 'no address to send it to' })
  assert.ok(
    stranded.some((row) => row.kind === 'error' && String(row.payload.message).includes('could not be refiled')),
    'work with nowhere to go is',
  )
}

// A delivery the agent answered with silence. This is how a caller ends up
// never hearing that something needs their sign-off.
{
  const written: { kind: string; payload: Record<string, unknown> }[] = []
  const trace = createCallTrace((kind, payload) => written.push({ kind, payload }))
  const expected = trace.expectTurn({
    cause: 'mailbox_delivery',
    workIds: ['work-1'],
    deliveryKinds: ['needs_approval'],
  })
  expected.release()
  assert.ok(written.some((row) => row.payload.trace === 'delivery_unspoken'))
  assert.ok(
    written.some((row) => row.kind === 'error' && String(row.payload.message).includes('sign-off')),
    'an unspoken approval is an error, not a footnote',
  )
  // And a released expectation can never be attributed to a later utterance.
  trace.agentTurn({ itemId: 'item-1', text: 'Anyway, where were we?' })
  const turn = written.find((row) => row.payload.trace === 'turn')!
  assert.equal(turn.payload.cause, 'spontaneous')
}

// A silent model route followed immediately by deterministic TTS is not an
// unspoken delivery. Only the final route gets to write that fault.
{
  const written: { kind: string; payload: Record<string, unknown> }[] = []
  const trace = createCallTrace((kind, payload) => written.push({ kind, payload }))
  const modelRoute = trace.expectTurn({
    cause: 'mailbox_delivery',
    workIds: ['work-1'],
    deliveryKinds: ['needs_approval'],
  })
  assert.equal(modelRoute.release({ recordUnspoken: false }).spoke, false)
  assert.equal(written.length, 0, 'the fallback still has a chance to tell the caller')

  const directRoute = trace.expectTurn({
    cause: 'mailbox_delivery',
    workIds: ['work-1'],
    deliveryKinds: ['needs_approval'],
  })
  trace.agentTurn({ itemId: 'direct-tts-1', text: 'That email needs your sign-off before it can be sent.' })
  assert.equal(directRoute.release().spoke, true)
  assert.ok(!written.some((row) => row.payload.trace === 'delivery_unspoken'))
}

// No picture ever reaches the ledger: one base-64 frame in a payload makes the
// whole table unqueryable, which is why takeAbilityFrame exists everywhere else.
{
  const written: Record<string, unknown>[] = []
  const trace = createCallTrace((_kind, payload) => written.push(payload))
  trace.settled({
    workId: 'work-1',
    status: 'done',
    answer: `Here is the page: data:image/jpeg;base64,${'A'.repeat(5_000)} — they open at nine.`,
    seconds: 3,
  })
  const answer = String(written.find((row) => row.trace === 'work_settled')!.answer)
  assert.ok(!answer.includes('AAAA'), 'the frame is gone')
  assert.ok(answer.includes('[image]') && answer.includes('they open at nine'), 'the words around it are not')
  assert.ok(answer.length < 500, 'and every line is bounded')
}

// --- what the call can do about a page, and what it says it can do --------
// Contract three. Every one of these is a sentence an agent was actually given
// that did not match the tools it actually had.
{
  const full = resolvePageAccess({
    abilityNames: ['web_search', 'read_page', 'browser_open', 'browser_click'],
    computerUse: 'trusted',
  })
  assert.equal(full.route, 'browser', 'with a usable browser the page gets visited')
  assert.equal(full.work, '', 'nothing needs saying about it')
  assert.equal(full.talk, '')

  // The dial parks every open: the browser is held but not usable, and the
  // agent must be told what that costs — not left to find out three parked
  // pages into a call while the caller waits.
  const parked = resolvePageAccess({
    abilityNames: ['web_search', 'read_page', 'browser_open', 'browser_click'],
    computerUse: 'approval',
  })
  assert.equal(parked.route, 'fetch')
  assert.match(parked.reason, /sign-off/)
  assert.match(parked.work, /still works/, 'reading a page is NOT withdrawn — that was the regression')
  assert.match(parked.talk, /cannot/, 'and the talker knows what it cannot promise')

  // An ability that continues an approved step files no request of its own, so
  // an 'approval' dial does not park it and the browser is usable after all.
  assert.equal(
    resolvePageAccess({
      abilityNames: ['read_page', 'browser_open'],
      computerUse: 'approval',
      browserApproval: 'continues',
    }).route,
    'browser',
  )

  // Forbidden, and no Chromium on the box: both are the quiet route, both with
  // a reason an operator can act on.
  assert.equal(resolvePageAccess({ abilityNames: ['read_page', 'browser_open'], computerUse: 'forbidden' }).route, 'fetch')
  const headless = resolvePageAccess({ abilityNames: ['web_search', 'read_page'], computerUse: 'trusted' })
  assert.equal(headless.route, 'fetch')
  assert.match(headless.reason, /no browser/)

  // THE contract: no words this resolution produces may name a tool. Naming
  // one is how "read pages with read_webpage instead" survived the ability
  // being folded away — the sentence was still true-sounding and completely
  // undoable.
  for (const access of [full, parked, headless]) {
    assert.deepEqual(toolsPromisedButAbsent(access.work, []), [], 'the work brief names no tool at all')
    assert.deepEqual(toolsPromisedButAbsent(access.talk, []), [], 'and neither do the words the caller hears')
  }
}

// --- a promise the tools cannot keep is caught, not shipped ----------------
{
  const held = ['do_work', 'check_work', 'end_call']
  assert.deepEqual(toolsPromisedButAbsent('Hand it to do_work and use check_work to see where it is.', held), [])
  assert.deepEqual(
    toolsPromisedButAbsent('Read pages with read_webpage instead.', held),
    ['read_webpage'],
    'the exact sentence that was live for weeks',
  )
  assert.deepEqual(
    toolsPromisedButAbsent('Use read_webpage, then read_webpage again.', held),
    ['read_webpage'],
    'named twice is one broken promise',
  )
  assert.deepEqual(
    toolsPromisedButAbsent('Say what you are doing and never guess at a page.', held),
    [],
    'ordinary English is not a tool name',
  )
}

console.log('call: coalesced, prioritized, rate limited, deduplicated, never over the agent — and every decision on the record')
