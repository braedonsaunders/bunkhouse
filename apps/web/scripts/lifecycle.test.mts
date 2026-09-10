import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  PERSON_STATUS_TRANSITIONS,
  assertPersonStatusTransition,
  isPersonStatus,
  type PersonStatus,
} from '../src/lib/person-lifecycle'
import {
  RUN_ATTEMPT_TRANSITIONS,
  assertRunAttemptTransition,
  type RunAttemptEventKind,
} from '../src/lib/run-attempt-lifecycle'
import {
  CHAT_DISPATCH_TRANSITIONS,
  assertChatDispatchTransition,
  type ChatDispatchStatus,
} from '../src/lib/chat-dispatch-lifecycle'
import { chatQueueUiProjection } from '../src/lib/chat-ui-state'

function assertCompleteMatrix<State extends string>(
  transitions: Record<State, readonly State[]>,
  assertTransition: (from: State, to: State) => void,
): void {
  const states = Object.keys(transitions) as State[]
  assert.ok(states.length > 1)
  for (const from of states) {
    assert.equal(new Set(transitions[from]).size, transitions[from].length, `${from} has duplicate edges`)
    for (const to of transitions[from]) assert.ok(states.includes(to), `${from} points to unknown state ${to}`)
    for (const to of states) {
      if (transitions[from].includes(to)) assert.doesNotThrow(() => assertTransition(from, to), `${from} → ${to}`)
      else assert.throws(() => assertTransition(from, to), undefined, `${from} ↛ ${to}`)
    }
  }
}

assertCompleteMatrix<PersonStatus>(PERSON_STATUS_TRANSITIONS, assertPersonStatusTransition)
assert.equal(isPersonStatus('active'), true)
assert.equal(isPersonStatus('paused'), false)
assert.deepEqual(PERSON_STATUS_TRANSITIONS.offboarded, ['onboarding'], 'rehire must pass through onboarding')

assertCompleteMatrix<RunAttemptEventKind>(RUN_ATTEMPT_TRANSITIONS, assertRunAttemptTransition)
for (const state of Object.keys(RUN_ATTEMPT_TRANSITIONS) as RunAttemptEventKind[]) {
  if (state === 'claimed') assert.doesNotThrow(() => assertRunAttemptTransition(null, state))
  else assert.throws(() => assertRunAttemptTransition(null, state), /must begin with a claim/)
}
for (const terminal of ['completed', 'failed', 'cancelled', 'lease_lost'] as const) {
  assert.deepEqual(RUN_ATTEMPT_TRANSITIONS[terminal], [], `${terminal} must stay terminal`)
}

assertCompleteMatrix<ChatDispatchStatus>(CHAT_DISPATCH_TRANSITIONS, assertChatDispatchTransition)
assert.deepEqual(CHAT_DISPATCH_TRANSITIONS.failed, ['queued', 'cancelled'], 'only a person may resolve the failure barrier')
assert.deepEqual(CHAT_DISPATCH_TRANSITIONS.completed, [])
assert.deepEqual(CHAT_DISPATCH_TRANSITIONS.cancelled, [])

const queue = chatQueueUiProjection([
  { id: 'done', body: 'Already done', status: 'completed', lastError: null },
  { id: 'running', body: 'Working now', status: 'running', lastError: null },
  { id: 'waiting', body: 'Do this next', status: 'queued', lastError: null },
  { id: 'failed', body: 'Needs attention', status: 'failed', lastError: 'The provider timed out.' },
  { id: 'removed', body: 'Removed', status: 'cancelled', lastError: null },
])
assert.equal(queue.state, 'running', 'active work takes visual precedence over recovery')
assert.deepEqual(queue.messages.map(({ id, position, status }) => ({ id, position, status })), [
  { id: 'waiting', position: 1, status: 'queued' },
  { id: 'failed', position: 2, status: 'failed' },
])
assert.equal(queue.messages[0]?.editable, true)
assert.equal(queue.messages[1]?.retryable, true)
assert.equal(queue.messages[1]?.statusLabel, 'The provider timed out.')
assert.equal(chatQueueUiProjection([{ id: 'failed', body: 'Retry', status: 'failed', lastError: null }]).state, 'recovering')
assert.deepEqual(chatQueueUiProjection([]), { state: 'idle', messages: [] })

// "Send now" is an interrupt, not a reorder. The first version moved the
// dispatch's `position`, which the database rejects outright
// (`enforce_chat_dispatch_change`: FIFO position is immutable) — so it could never
// have worked, and the unique-index collision it appeared to hit was a symptom.
// Delivering the words into the running turn needs no ordering at all, so a failed
// message ahead of it is irrelevant to whether the agent can hear this one.
assert.equal(queue.messages[0]?.sendable, true, 'a waiting message can be said now even behind a failure')
assert.equal(queue.messages[1]?.sendable, false, 'a failed message is retried, never "sent now"')
const clear = chatQueueUiProjection([
  { id: 'running', body: 'Working now', status: 'running', lastError: null },
  { id: 'first', body: 'Next', status: 'queued', lastError: null },
  { id: 'second', body: 'After that', status: 'queued', lastError: null },
])
assert.deepEqual(
  clear.messages.map(({ id, sendable }) => ({ id, sendable })),
  [{ id: 'first', sendable: true }, { id: 'second', sendable: true }],
)

// These contracts must remain production boundaries, not test-only diagrams.
const organizationActions = readFileSync(new URL('../src/app/organization/actions.ts', import.meta.url), 'utf8')
const runExecution = readFileSync(new URL('../src/lib/run-execution.ts', import.meta.url), 'utf8')
const chatDispatch = readFileSync(new URL('../src/lib/chat-dispatch.ts', import.meta.url), 'utf8')
const chatWorkspace = readFileSync(new URL('../src/components/chat-workspace.tsx', import.meta.url), 'utf8')
assert.match(organizationActions, /assertPersonStatusTransition/)
assert.match(runExecution, /assertRunAttemptTransition/)
assert.match(chatDispatch, /assertChatDispatchTransition/)
assert.match(chatWorkspace, /chatQueueUiProjection/)

// Steering never touches the queue's order, and the queue's order is why: the
// database refuses any change to `position`, so a feature built on reordering was
// unshippable by construction.
assert.equal(chatDispatch.includes('promote'), false, 'no code reorders the queue any more')
const steer = readFileSync(new URL('../src/lib/chat-steer.ts', import.meta.url), 'utf8')
assert.match(steer, /status: 'cancelled'/, 'a delivered dispatch never gets a turn of its own')
assert.match(steer, /kind: 'steered'/, 'and the event is what says it was delivered rather than discarded')
assert.match(
  steer,
  /gt\(chatMessages\.at, run\.startedAt\)/,
  "a run never re-reads its own prompt as if it were a correction",
)
assert.match(
  steer,
  /consumedMessageIds/,
  'delivery is at-most-once, so a long run does not meet the same correction every step',
)
assert.equal(
  /update\s+chatDispatches[\s\S]{0,200}position/.test(steer),
  false,
  'steering writes no position',
)

// --- a duty belonging to somebody who may not work is not due ---------------
//
// `workRefusal` is the gate, and `executeAgentRun` honours it — but a duty that
// fires into that refusal still opens a run whose entire content is the refusal,
// on a schedule, for as long as the duty is enabled. Three agents left in
// `onboarding` with twelve enabled cron duties between them opened 171 runs over
// 24 days; every one failed on arrival and recorded nothing but the fact that
// hiring had never been finished.
//
// Offboarding already switches duties off, so `onboarding` was the state with no
// edge — which is exactly the shape of gap this file exists to catch.
{
  const agentRuns = readFileSync(new URL('../src/lib/agent-runs.ts', import.meta.url), 'utf8')
  const due = agentRuns.slice(agentRuns.indexOf('export async function dueDuties'))
  const body = due.slice(0, due.indexOf('\n}'))
  assert.match(body, /innerJoin\(people/, 'the due-duty query asks who the duty belongs to')
  assert.match(body, /eq\(people\.status, 'active'\)/, 'and only an active person has due duties')
  assert.match(body, /eq\(people\.kind, 'agent'\)/, 'a human colleague is not run by the scheduler')
  // Skipped, not advanced: nothing may be consumed on behalf of a person who
  // never got the occurrence, or a duty finishes its `maxRuns` while standing
  // still and retires before its owner is ever hired.
  assert.equal(
    /markDutyRun|runCount/.test(body),
    false,
    'a skipped occurrence spends no run budget',
  )
}

console.log('lifecycle: exhaustive person, execution-attempt, dispatch, and queue-UI state matrices verified')
