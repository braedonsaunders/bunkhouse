import assert from 'node:assert/strict'

// What a reloaded conversation gets back, proved without a database: the fold
// from run-ledger events to transcript activity, and the guard that keeps a
// model's proposed thread name from becoming a truncated sentence.

const { cleanProposedTitle } = await import('../src/lib/chat-title')

let failures = 0
async function check(what: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run()
    console.log(`  ok   ${what}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${what}`)
    console.log(`       ${error instanceof Error ? error.message : String(error)}`)
  }
}

// `foldRun` is deliberately not exported — it is an implementation detail of
// the reader — so the fold is exercised through the same shapes the ledger
// produces, via a tiny re-implementation-free import of the module's internals.
const activityModule = await import('../src/lib/chat-activity')
type Activity = import('../src/lib/chat-activity').ChatMessageActivity

/**
 * The reader takes rows straight from `run_events`; this is the same fold with
 * the database call removed, so the ordering and pairing rules are the thing
 * under test rather than drizzle.
 */
function fold(rows: { kind: string; payload: Record<string, unknown> }[]): Activity[] {
  const internals = activityModule as unknown as {
    __foldRunForTests?: (rows: { runId: string; kind: string; payload: Record<string, unknown> }[]) => Activity[]
  }
  assert.ok(internals.__foldRunForTests, 'chat-activity must expose its fold for testing')
  return internals.__foldRunForTests(rows.map((row) => ({ runId: 'run-1', ...row })))
}

console.log('run ledger → transcript activity')

await check('a thought becomes reasoning, in the order it was recorded', () => {
  const activity = fold([
    { kind: 'thought', payload: { text: 'The deposit total has to come from the GL, not the bank feed.' } },
    { kind: 'tool_call', payload: { toolCallId: 'c1', toolName: 'run_tool', input: { q: 'deposits' } } },
    { kind: 'tool_result', payload: { toolCallId: 'c1', toolName: 'run_tool', output: { ok: true, total: 15773.31 } } },
  ])
  assert.equal(activity.length, 2)
  assert.deepEqual(activity[0], { kind: 'thought', text: 'The deposit total has to come from the GL, not the bank feed.' })
  assert.equal(activity[1]!.kind, 'tool')
})

await check('a result is matched to its call by toolCallId, not by position', () => {
  const activity = fold([
    { kind: 'tool_call', payload: { toolCallId: 'a', toolName: 'first', input: 1 } },
    { kind: 'tool_call', payload: { toolCallId: 'b', toolName: 'second', input: 2 } },
    // Deliberately out of order.
    { kind: 'tool_result', payload: { toolCallId: 'b', toolName: 'second', output: 'B' } },
    { kind: 'tool_result', payload: { toolCallId: 'a', toolName: 'first', output: 'A' } },
  ])
  assert.equal(activity.length, 2)
  assert.deepEqual(activity.map((entry) => entry.kind === 'tool' ? [entry.toolName, entry.output] : null), [
    ['first', 'A'],
    ['second', 'B'],
  ])
})

await check('a result with no toolCallId falls back to the first call of that name', () => {
  const activity = fold([
    { kind: 'tool_call', payload: { toolName: 'run_tool', input: 1 } },
    { kind: 'tool_result', payload: { toolName: 'run_tool', output: 'done' } },
  ])
  assert.equal(activity.length, 1)
  assert.equal(activity[0]!.kind === 'tool' ? activity[0].output : null, 'done')
})

await check('a call that never returned keeps a null output rather than looking successful', () => {
  const activity = fold([{ kind: 'tool_call', payload: { toolCallId: 'c1', toolName: 'run_shell', input: {} } }])
  assert.equal(activity.length, 1)
  assert.equal(activity[0]!.kind === 'tool' ? activity[0].output : 'unset', null)
})

await check('a failed step is carried through as failed', () => {
  const activity = fold([
    { kind: 'tool_call', payload: { toolCallId: 'c1', toolName: 'run_tool', input: {} } },
    { kind: 'tool_result', payload: { toolCallId: 'c1', toolName: 'run_tool', output: { ok: false, error: 'nope' } } },
  ])
  assert.equal(activity[0]!.kind === 'tool' ? activity[0].ok : true, false)
})

await check('a successful step is not mistaken for a failed one', () => {
  const activity = fold([
    { kind: 'tool_call', payload: { toolCallId: 'c1', toolName: 'run_tool', input: {} } },
    { kind: 'tool_result', payload: { toolCallId: 'c1', toolName: 'run_tool', output: { ok: true } } },
  ])
  assert.equal(activity[0]!.kind === 'tool' ? activity[0].ok : false, true)
})

await check('an empty thought contributes nothing', () => {
  assert.deepEqual(fold([{ kind: 'thought', payload: { text: '   ' } }]), [])
})

await check('an orphan result with no call is dropped rather than inventing a card', () => {
  assert.deepEqual(fold([{ kind: 'tool_result', payload: { toolCallId: 'ghost', toolName: 'x', output: 1 } }]), [])
})

console.log('proposed thread titles')

await check('a plain title is kept', () => {
  assert.equal(cleanProposedTitle('Daily deposit verification'), 'Daily deposit verification')
})

await check('quotes, trailing punctuation and preamble whitespace are stripped', () => {
  assert.equal(cleanProposedTitle('  "Daily deposit verification."  '), 'Daily deposit verification')
  assert.equal(cleanProposedTitle('“NetSuite balance check”'), 'NetSuite balance check')
})

await check('only the first line survives', () => {
  assert.equal(cleanProposedTitle('NetSuite balance check\nAlso: something else'), 'NetSuite balance check')
})

await check('a model that wrote a sentence is refused rather than clipped', () => {
  const sentence = 'This conversation is about verifying the daily deposit totals in NetSuite and then '
    + 'deciding whether to send the summary email to the owner for review.'
  assert.equal(cleanProposedTitle(sentence), null)
})

await check('an empty answer is refused', () => {
  assert.equal(cleanProposedTitle(''), null)
  assert.equal(cleanProposedTitle('   \n  '), null)
  assert.equal(cleanProposedTitle('""'), null)
})

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
