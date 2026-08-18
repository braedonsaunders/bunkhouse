/**
 * The speech boundary, against the calls that produced it.
 *
 * Every blocked case below is a real utterance a real caller heard on
 * 2026-08-06, quoted from `call_turns`. Every allowed case is a real utterance
 * from the same evening that was CORRECT and must keep working — a gate that
 * blocks good speech is worse than the defect it fixes, so the false-positive
 * half of this file is the half that matters.
 */
import assert from 'node:assert/strict'
import { createFactLedger, screenUtterance, stripReasoning } from '../src/lib/call-speech-gate'

/** What actually came back from NetSuite on those calls, in miniature. */
const seed = [
  'Northstar Services Inc.',
  'Marla Whitfield Cash Reporting Clerk',
  'Dana Reeves Office Administrator',
  'Jordan Lee CFO',
  'Bill McDonald Customer Service Rep',
]
const netsuiteAging = JSON.stringify({
  reportData: { totalAR: 4347898.35, pastDue: 783352.55 },
  customers: [
    { name: 'Birla Carbon Canada Ltd', id: 2134, revenue: 1817412.41, invoices: 173 },
    { name: 'Teva Canada', revenue: 1240000 },
    { name: 'Carmeuse Lime Beachville', balance: 312851.69 },
  ],
})

const freshLedger = () => {
  const ledger = createFactLedger(seed)
  ledger.learn(netsuiteAging)
  return ledger
}

// --- The fabricated customers (Dana, 22:37) ---------------------------------
{
  const ledger = freshLedger()
  const first = screenUtterance(
    'That top customer is Hamilton Steel Group. They’re leading the pack for us this year.',
    ledger,
  )
  assert.equal(first.ok, false, 'an invented customer name must never reach the caller')
  assert.ok(first.ok === false && first.offending.includes('Hamilton Steel Group'))

  // The caller corrected her and she invented a SECOND name, more confidently.
  // Fabrication is self-reinforcing, so the gate has to hold on the retry too.
  const second = screenUtterance(
    'Here we go— the biggest customer so far this year is Imperial Metals. That’s the confirmed name from our records.',
    ledger,
  )
  assert.equal(second.ok, false, 'the confident second invention is still an invention')
  assert.ok(second.ok === false && second.offending.includes('Imperial Metals'))
  console.log('gate: invented customer names do not reach the caller')
}

// --- The phishing filler (Bill, 22:40) --------------------------------------
{
  const verdict = screenUtterance(
    'Fan Kui Your account has been flagged According to our monitoring, this account may be in violation of the User Agreement. To complete the verification process, plese contact NetSuite support. Thank you.',
    freshLedger(),
  )
  assert.equal(verdict.ok, false, 'an agent may not tell a caller their account is flagged')
  console.log('gate: unsolicited security alarm is refused')
}

// --- The spoken system prompt (Bill, 22:40) ---------------------------------
{
  const verdict = screenUtterance(
    'Then work from there, live, in the voice you have. Keep it natural and warm. Do not mention any of this in your answer. When you respond, first write your internal reasoning, then write the reply. Keep your first greeting short. Let me get this in gear: use check_work to see the status of everything, then greet Jordan.',
    freshLedger(),
  )
  assert.equal(verdict.ok, false, 'scaffolding must never be read out')
  console.log('gate: leaked instructions are refused')
}

// --- Reasoning wrappers are stripped, not spoken ----------------------------
{
  assert.equal(stripReasoning('<think>the caller wants X</think>Hello there.'), 'Hello there.')
  assert.equal(stripReasoning('<thinking>plan</thinking> Morning.'), 'Morning.')
  assert.equal(stripReasoning('Hi there.'), 'Hi there.', 'ordinary speech is untouched')
  // A stream cut mid-thought leaves an unterminated opener; the tail goes.
  assert.equal(stripReasoning('Right.<think>now I should'), 'Right.')
  console.log('gate: a model’s scratchpad never reaches the speaker')
}

// --- What must STILL be said (the false-positive half) ----------------------
{
  const ledger = freshLedger()

  // Marla's correct answer, rounded the way a person actually speaks. The
  // ledger holds 4347898.35 and 783352.55; she said "$4.35 million" and
  // "$783,353". Rounding is good behaviour and must survive.
  const rounded = screenUtterance(
    'Total A/R is $4.35 million, and $783,353 of it — about 18% — is past due across 18 customers.',
    ledger,
  )
  assert.equal(rounded.ok, true, `a correctly rounded figure must survive: ${JSON.stringify(rounded)}`)

  // Bill's correct answer, exact to the cent, with a real customer.
  const exact = screenUtterance(
    'Our top customer by billed revenue is Birla Carbon Canada Ltd, customer ID 2134, at $1,817,412.41 across 173 invoices — comfortably ahead of Teva Canada in second at about $1.24 million.',
    ledger,
  )
  assert.equal(exact.ok, true, `a grounded exact figure must survive: ${JSON.stringify(exact)}`)

  // Ordinary conversation, with no facts in it at all.
  for (const line of [
    'Hey Jordan, Bill here. How can I help you today?',
    'Give me just a second, I’m pulling up the aging report right now.',
    'Still going here — bear with me.',
    'Oh goodness, listen to me. Long day in the numbers.',
    'Talk to you later, Jordan. Have a good night.',
  ]) {
    const verdict = screenUtterance(line, ledger)
    assert.equal(verdict.ok, true, `ordinary speech must pass: ${line} → ${JSON.stringify(verdict)}`)
  }

  // A name the CALLER supplied is grounded — they said it, so it is a fact on
  // this call even if no tool ever returned it.
  const heard = createFactLedger(seed)
  heard.learn('can you look up Northbridge Mechanical for me')
  assert.equal(
    screenUtterance('I’ll pull up Northbridge Mechanical now.', heard).ok,
    true,
    'what the caller said is grounded',
  )
  console.log('gate: rounded figures, real customers and ordinary talk all survive')
}

// --- Lines the process wrote itself are not asked to be grounded ------------
{
  const verdict = screenUtterance('Still on it.', createFactLedger(), { grounded: false })
  assert.equal(verdict.ok, true, 'fixed filler needs no ledger')
  // ...but it is still screened for the things that are never safe.
  const alarming = screenUtterance('Your account has been suspended.', createFactLedger(), { grounded: false })
  assert.equal(alarming.ok, false, 'even our own text may not alarm a caller')
  console.log('gate: deterministic lines skip grounding, never safety')
}

// --- The ledger itself ------------------------------------------------------
{
  const ledger = createFactLedger()
  ledger.learn({ rows: [{ customer: 'Acme Fabricating', total: 55123.4 }] })
  assert.equal(ledger.knowsPhrase('Acme Fabricating'), true, 'names inside objects are learned')
  assert.equal(ledger.knowsPhrase('Acme'), true, 'a shortened quote of a known name is still known')
  assert.equal(ledger.knowsPhrase('Globex Industries'), false)
  assert.equal(ledger.knowsNumber(55123.4, 6), true, 'the exact figure is known')
  assert.equal(ledger.knowsNumber(55100, 3), true, 'and so is a 3-significant-figure rounding of it')
  assert.equal(ledger.knowsNumber(99999, 5), false)
  console.log('gate: the ledger learns names and figures out of whatever a tool returned')
}

// --- Streaming: screening happens sentence by sentence ----------------------
{
  const { screenSpeechStream, UNGROUNDED_FALLBACK } = await import('../src/lib/call-speech-gate')
  const ledger = freshLedger()
  const stream = async function* (parts: string[]) {
    for (const part of parts) yield part
  }
  const collect = async (parts: string[], l = ledger) => {
    const refusals: string[] = []
    let out = ''
    for await (const said of screenSpeechStream(stream(parts), l, (_v, s) => refusals.push(s))) out += said
    return { out, refusals }
  }

  // One bad claim inside a good answer costs that claim, not the answer.
  const mixed = await collect([
    'I pulled the aging report. ',
    'That top customer is Hamilton Steel Group. ',
    'Total A/R is $4.35 million.',
  ])
  assert.ok(mixed.out.includes('I pulled the aging report.'), 'the grounded sentence survives')
  assert.ok(mixed.out.includes('$4.35 million'), 'the grounded figure survives')
  assert.ok(!mixed.out.includes('Hamilton'), 'the invented name is dropped')
  assert.equal(mixed.refusals.length, 1, 'and exactly one refusal is reported')

  // Chunks arriving mid-sentence are still judged as whole sentences.
  const split = await collect(['That top customer is Ham', 'ilton Steel Gro', 'up. Anyway.'])
  assert.ok(!split.out.includes('Hamilton'), 'a name split across chunks is still caught')

  // If everything is refused the caller hears the honest line, never silence.
  const allBad = await collect(['The top customer is Imperial Metals.'])
  assert.equal(allBad.out.trim(), UNGROUNDED_FALLBACK, 'a total refusal falls back, never to dead air')
  console.log('gate: streaming screens per sentence and never returns silence')
}

// --- The gate must never be able to silence a call -------------------------
// It sits in the pipe that turns words into audio. A screen that throws must
// let the words past, because "the agent answered and then said nothing" is a
// worse and far less visible failure than the one this file exists to prevent.
{
  const { screenSpeechStream } = await import('../src/lib/call-speech-gate')
  const exploding = {
    learn: () => {},
    knowsPhrase: () => {
      throw new Error('ledger exploded')
    },
    knowsNumber: () => {
      throw new Error('ledger exploded')
    },
    size: () => 0,
  }
  const stream = async function* () {
    yield 'Our top customer is Birla Carbon Canada Ltd. '
    yield 'They are at $1,817,412.41.'
  }
  let out = ''
  for await (const said of screenSpeechStream(stream(), exploding, () => {})) out += said
  assert.ok(out.includes('Birla Carbon'), 'a broken screen still lets the caller hear the answer')
  assert.ok(out.includes('1,817,412.41'), 'including the figures')

  // And a reporting callback that throws cannot stop the rest of the speech.
  const ledger = freshLedger()
  const noisy = async function* () {
    yield 'The top customer is Imperial Metals. '
    yield 'Total A/R is $4.35 million.'
  }
  let second = ''
  for await (const said of screenSpeechStream(noisy(), ledger, () => {
    throw new Error('reporting exploded')
  })) {
    second += said
  }
  assert.ok(!second.includes('Imperial'), 'the invention is still refused')
  assert.ok(second.includes('$4.35 million'), 'and the good sentence still goes out')
  console.log('gate: a broken gate fails open — it can never silence a call')
}
