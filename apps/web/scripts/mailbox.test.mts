import assert from 'node:assert/strict'
import { createCallMailbox, type MailboxDelivery, type MailboxTiming } from '../src/lib/call-mailbox'

/**
 * The delivery mailbox, which exists because of one bug: anything the worker
 * said reached the caller as a fresh reply and cut off the speech already in
 * their ear. Every rule below is one half of that fix — hold until the line is
 * quiet, then say everything waiting once.
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

/** A line the mailbox is watching, and what it has been told to say. */
function harness(timing: Partial<MailboxTiming> = {}) {
  const delivered: MailboxDelivery[] = []
  let quiet = true
  const mailbox = createCallMailbox({
    isQuiet: () => quiet,
    deliver: async (delivery) => {
      delivered.push(delivery)
    },
    timing: { ...FAST, ...timing },
    onError: (message) => assert.fail(`the mailbox reported an error: ${message}`),
  })
  return {
    mailbox,
    delivered,
    /** What the caller has actually heard, in order. */
    heard: () => delivered.map((delivery) => delivery.text),
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
}

console.log('mailbox: coalesced, prioritized, rate limited, deduplicated, and never over the agent')
