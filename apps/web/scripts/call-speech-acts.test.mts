/**
 * Speech acts: what the work has to say, as a shape rather than a sentence.
 *
 * The defect these exist for, quoted from `call_turns` on 2026-08-06: handed
 * the progress note "Checking NetSuite" and asked to put it in its own words, an
 * agent said "Just got it — our biggest customer is a major steel processing
 * client", then named a company that does not exist. A status note contains no
 * answer, so nothing that renders one may be able to produce one.
 */
import assert from 'node:assert/strict'
import {
  isPresenceOnly,
  mayBeVoicedByModel,
  renderDelivery,
  renderSpeechAct,
  type SpeechAct,
} from '../src/lib/call-speech-acts'

const progress: SpeechAct = { type: 'progress', workId: 'work-1', activity: 'Checking NetSuite' }
const result: SpeechAct = {
  type: 'result',
  workId: 'work-1',
  answer: 'Our top customer is Birla Carbon Canada Ltd at $1,817,412.41.',
}
const approval: SpeechAct = {
  type: 'approval',
  workId: 'work-2',
  action: 'Sending the reply — it needs a manager’s sign-off before it can happen.',
}
const failed: SpeechAct = { type: 'failed', workId: 'work-3', trouble: 'That ran into trouble: NetSuite timed out.' }

// --- only an answer may be phrased by a model -------------------------------
{
  assert.equal(mayBeVoicedByModel(result), true, 'a result carries facts and may be phrased')
  assert.equal(mayBeVoicedByModel(progress), false, 'a status note must never be handed to a model to phrase')
  assert.equal(mayBeVoicedByModel(approval), false, 'an approval must reach the caller unembellished')
  assert.equal(mayBeVoicedByModel(failed), false, 'so must trouble')
  console.log('speech acts: only an answer may be put into a model’s own words')
}

// --- progress is presence, and may be dropped without losing anything -------
{
  assert.equal(isPresenceOnly(progress), true)
  for (const act of [result, approval, failed]) {
    assert.equal(isPresenceOnly(act), false, `${act.type} carries something the caller does not have`)
  }
  console.log('speech acts: progress is the only act that can be skipped safely')
}

// --- rendering is a function of the act and nothing else --------------------
{
  assert.equal(renderSpeechAct(progress), 'Checking NetSuite')
  assert.ok(renderSpeechAct(result).includes('Birla Carbon Canada Ltd'), 'the answer survives intact')
  assert.ok(renderSpeechAct(result).includes('1,817,412.41'), 'and so do its figures')

  // The rendering cannot introduce anything: whatever comes out is contained in
  // what went in. This is the property that makes the act safe.
  for (const act of [progress, result, approval, failed]) {
    const rendered = renderSpeechAct(act)
    const source = act.type === 'progress' ? act.activity : act.type === 'result' ? act.answer : act.type === 'approval' ? act.action : act.trouble
    assert.ok(source.includes(rendered.replace(/…$/, '')), `${act.type} rendered nothing it was not given`)
  }

  // Whitespace is normalised so a multi-line note does not arrive as a pause.
  assert.equal(renderSpeechAct({ type: 'progress', workId: 'w', activity: 'a\n\n  b ' }), 'a b')
  console.log('speech acts: rendering adds nothing that was not in the act')
}

// --- long text is clipped on a word boundary, not mid-word ------------------
{
  const long = renderSpeechAct({ type: 'progress', workId: 'w', activity: `${'word '.repeat(60)}end` })
  assert.ok(long.length <= 121, `clipped: ${long.length}`)
  assert.ok(long.endsWith('…'), 'and says it was clipped')
  assert.ok(!/\bwor…$/.test(long), 'never mid-word')
  console.log('speech acts: a long line is clipped where a person would pause')
}

// --- several acts at one boundary stay separate facts -----------------------
{
  const delivery = renderDelivery([progress, approval])
  assert.equal(delivery.split('\n').length, 2, 'one line each — never run into a paragraph')
  assert.equal(renderDelivery([]), '', 'nothing to say is nothing said')
  console.log('speech acts: a boundary’s worth of acts stays a list, not a sentence')
}
