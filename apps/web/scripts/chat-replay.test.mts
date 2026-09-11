import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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

// --- the turn that has not landed yet ---------------------------------------
//
// A reader who reloads mid-turn used to see their own prompt and nothing else:
// the agent's message is appended when the run finishes, so every call already
// made and every finished sentence was invisible. A run that legitimately works
// for ten minutes was a blank conversation for ten minutes.
await check('a live turn renders its calls as running, not as failures', () => {
  const workspace = readFileSync(
    fileURLToPath(new URL('../src/components/chat-workspace.tsx', import.meta.url)),
    'utf8',
  )
  const live = workspace.slice(
    workspace.indexOf('function liveTurnMessage'),
    workspace.indexOf('function stampLabel'),
  )
  // The one difference from a recovered FINISHED turn, and the whole point: there
  // an unreturned call means the run died inside it, here it means the tool is
  // still working.
  assert.match(live, /state: entry\.output === null \? \('input-available' as const\)/)
  assert.equal(live.includes('output-error'), false, 'a call still running is never shown as an error')
  assert.match(live, /id: `live:\$\{live\.runId\}`/, 'the provisional message is identified as provisional')

  const finished = workspace.slice(workspace.indexOf('function toAgentMessage'), workspace.indexOf('function liveTurnMessage'))
  assert.match(
    finished,
    /state: entry\.output === null \? \('output-error' as const\)/,
    'a FINISHED turn still reports an unreturned call as the failure it was',
  )

  // It must never become a transcript entry: the transcript is append-only and
  // this is a provisional read of work in progress.
  assert.match(workspace, /liveTurn && !streamingTurn \? \[liveTurnMessage\(detail\.liveTurn\)\] : \[\]/)
})

await check('the live turn is read from the ledger and never duplicates recorded work', () => {
  const activity = readFileSync(
    fileURLToPath(new URL('../src/lib/chat-activity.ts', import.meta.url)),
    'utf8',
  )
  const liveTurn = activity.slice(activity.indexOf('export async function chatLiveTurn'))
  assert.match(liveTurn, /notInArray\(runs\.id, excludeRunIds\)/, 'a run already attributed to a message is skipped')
  assert.match(liveTurn, /inArray\(runs\.status, \[\.\.\.LIVE_RUN_STATUSES\]\)/, 'only an unfinished run is live')
  assert.match(
    activity,
    /const LIVE_RUN_STATUSES = \['running', 'waiting_approval', 'waiting_reply', 'waiting_credential'\] as const/,
    'a run parked on a wait is still in flight as far as a reader is concerned',
  )
  // Completed steps' prose is part of the answer that already exists; withholding
  // it until the run ends is the thing being fixed.
  assert.match(liveTurn, /'thought', 'tool_call', 'tool_result', 'message'/)

  const detail = readFileSync(fileURLToPath(new URL('../src/lib/chat-detail.ts', import.meta.url)), 'utf8')
  assert.match(
    detail,
    /message\.role === 'agent' && message\.runId \? \[message\.runId\] : \[\]/,
    'the exclusion list is every run the transcript already speaks for',
  )
})

// --- a thread's work includes the work it scheduled -------------------------
//
// The conversation pane matched runs on `trigger->>'conversationId'`, and a duty
// run is triggered by the clock so it has none. Scheduled work was therefore
// invisible in the very thread that created it: Avery's half-hourly scan ran on
// time, used the shell and wrote its result while the pane showed the last CHAT
// run's terminal instead. After an outage that read as "the desk could not be
// reached" hours after the desk was fixed — stale output presented as current.
await check('duty runs are resolved into their thread by provenance', () => {
  const duty = readFileSync(fileURLToPath(new URL('../src/lib/duty-conversation.ts', import.meta.url)), 'utf8')
  assert.match(duty, /export async function threadDutyIds/, 'the inverse of dutyConversationThreadId exists')
  assert.match(duty, /web:\$\{threadId\}/, 'and matches the in-app conversation prefix, not a Slack/Teams id')

  // The provenance is a CHAIN, and reading one link of it is what broke.
  //
  // An agent that re-books its own lane does so from inside a scheduled run, and
  // a duty run's trigger carries a dutyId rather than a conversation. Following
  // `source_run_id` once therefore resolved null for every self-renewed lane:
  // the replacement was born mute, fell back to email, and reported "no mailbox
  // is connected" while the lane it replaced had been posting for days. Two of
  // three live lanes were in that state, silently, and the chain breaks again on
  // every renewal.
  //
  // Verified against the live tenant before shipping: the watchdog lane reached
  // its chat turn in one hop and the wake loop in three, both landing on the same
  // thread as the lane that still worked.
  for (const [name, body] of [
    ['dutyConversationThreadId', duty.slice(duty.indexOf('export async function dutyConversationThreadId'), duty.indexOf('export async function threadDutyIds'))],
    ['threadDutyIds', duty.slice(duty.indexOf('export async function threadDutyIds'))],
  ] as const) {
    assert.match(body, /with recursive/, `${name} walks the chain rather than one link`)
  }

  // Bounded, because a renewal chain is short in practice and a cycle is possible
  // in principle. Unbounded recursion here would hang a chat turn.
  const forward = duty.slice(duty.indexOf('export async function dutyConversationThreadId'))
  assert.match(forward, /chain\.hop < \d+/, 'the forward walk is hop-bounded')
  // The reverse walk terminates by deduplication instead, so it must not be
  // `union all` — that would loop forever on a cycle.
  const reverse = duty.slice(duty.indexOf('export async function threadDutyIds'))
  // Comments stripped: the note explaining the choice quotes the rejected form.
  const reverseCode = reverse.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
  assert.equal(/union all/.test(reverseCode), false, 'the reverse walk dedupes, which is what terminates it')
  assert.match(reverse, /\bunion\b/, 'and it is still a recursive union')

  // A dutyId that is not a uuid must not reach a cast, or one malformed trigger
  // throws for every caller of this.
  assert.match(forward, /\[0-9a-fA-F-\]\{36\}/, 'the dutyId is shape-checked before casting')

  // Both surfaces have to agree with where a duty may SPEAK, or the conversation
  // claims one thing and its own work surface another.
  for (const file of ['../src/lib/chat-work-surface.ts', '../src/lib/chat-detail.ts']) {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
    assert.match(source, /threadDutyIds\(/, `${file} resolves the thread's duties`)
  }
  const surface = readFileSync(fileURLToPath(new URL('../src/lib/chat-work-surface.ts', import.meta.url)), 'utf8')
  assert.match(
    surface,
    /inArray\(sql`\$\{runs\.trigger\}->>'dutyId'`, dutyIds\)/,
    'the work surface matches duty runs by trigger dutyId',
  )
  // With no duties the query must stay exactly what it was — one predicate, no
  // empty IN list.
  assert.match(surface, /dutyIds\.length > 0\s*\?/, 'no duties means the original single-predicate query')
})

// --- a broken connector is not the employee talking -------------------------
//
// `RunEvent` documents `message` as "the utterance", so emitting integration
// failures there made every run open by speaking every unrelated failure into
// whatever conversation it belonged to. An expired NetSuite refresh token
// introduced itself, hostname and all, at the top of a conversation about
// launching a memecoin — one second after the run began, before the agent had
// done anything. Unactionable, unrelated, and it reads as the agent being
// confused about its own job.
await check('an unavailable integration is recorded, not spoken', () => {
  const runs = readFileSync(fileURLToPath(new URL('../src/lib/agent-runs.ts', import.meta.url)), 'utf8')
  const block = runs.slice(runs.indexOf('integrationFailures ?? []'))
  const emit = block.slice(0, block.indexOf('}') + 1)
  assert.match(emit, /kind: 'error'/, 'it lands on the ledger as a failure')
  assert.equal(emit.includes("kind: 'message'"), false, 'it is never emitted as the agent speaking')
  // Still recorded verbatim — the point is where it shows, not hiding it.
  assert.match(emit, /Integration unavailable — \$\{failure\}/)
})

// --- a failure has to say what failed ---------------------------------------
//
// `String(error)` on anything that is not an Error gives "[object Object]", and
// that is exactly what one run recorded as its entire summary on the live
// tenant: a chat turn asking the agent to set something up failed, the
// conversation said nothing useful, and the ledger held no clue either.
// Providers and SDKs throw plain objects routinely.
await check('a non-Error failure still produces something readable', async () => {
  const { readableFailure } = await import('../src/lib/agent-runs')
  assert.equal(readableFailure(new Error('provider refused the request')), 'provider refused the request')
  assert.equal(readableFailure('plain string'), 'plain string')
  assert.equal(readableFailure({ message: 'rate limited' }), 'rate limited')
  assert.equal(readableFailure({ error: 'invalid_grant' }), 'invalid_grant')

  // The case that produced "[object Object]": an object with no message at all.
  const serialized = readableFailure({ status: 429, detail: { retryAfter: 30 } })
  assert.equal(serialized.includes('[object Object]'), false, 'never the useless default')
  assert.match(serialized, /429/, 'the body is carried through rather than discarded')

  // Unserializable input must still not degrade to "[object Object]".
  const circular: Record<string, unknown> = { name: 'WeirdError' }
  circular.self = circular
  const cyclic = readableFailure(circular)
  assert.equal(cyclic.includes('[object Object]'), false)
  assert.match(cyclic, /WeirdError/)
})

// --- and the run loop's own catch is held to the same standard ---------------
//
// `readableFailure` above guards the app's side of the boundary, but it never saw
// the one failure that mattered: `runAgent` had already converted the thrown
// value with `String(error)`, so the run recorded an error event and a summary
// that both read "[object Object]" and the app faithfully passed the words on.
// `describeThrown` is the reader the tool path has used all along.
await check('a run that fails on a plain object says what failed', async () => {
  const { describeThrown } = await import('@bunkhouse/runtime')

  assert.equal(describeThrown(new Error('provider refused')), 'provider refused')
  assert.equal(describeThrown({ message: 'rate limited' }), 'rate limited')
  // An object with nothing readable on it — the live case.
  assert.equal(
    describeThrown({ status: 500 }, 'The run failed without reporting a reason.'),
    'The run failed without reporting a reason.',
  )
  assert.equal(describeThrown({}).includes('[object Object]'), false)
  // The tool path's wording is untouched by gaining the parameter.
  assert.equal(describeThrown({}), 'The tool failed without reporting a reason.')

  const { readFileSync } = await import('node:fs')
  const loop = readFileSync(new URL('../../../packages/runtime/src/loop.ts', import.meta.url), 'utf8')
  const caught = loop.slice(loop.lastIndexOf('} catch (error) {'))
  assert.match(caught, /describeThrown\(error, 'The run failed/, 'the loop reads the thrown value properly')
  // Comments stripped: the explanation of the old bug quotes the old call.
  const code = caught.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
  assert.equal(
    /String\(error\)/.test(code),
    false,
    'and no longer stringifies it into nothing',
  )
})

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
