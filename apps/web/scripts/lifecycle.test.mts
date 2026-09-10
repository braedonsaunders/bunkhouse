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

// "Send now" is offered only where the service would honour it. A failed turn is
// a deliberate barrier — the work behind it may be the work that depended on it —
// so nothing may jump it, and a button the service would refuse is worse than no
// button at all.
assert.equal(queue.messages[0]?.sendable, false, 'nothing is sent ahead of a failure in the same queue')
assert.equal(queue.messages[1]?.sendable, false, 'a failed message is retried, never "sent now"')
const clear = chatQueueUiProjection([
  { id: 'running', body: 'Working now', status: 'running', lastError: null },
  { id: 'first', body: 'Next', status: 'queued', lastError: null },
  { id: 'second', body: 'After that', status: 'queued', lastError: null },
])
assert.deepEqual(
  clear.messages.map(({ id, sendable }) => ({ id, sendable })),
  [{ id: 'first', sendable: true }, { id: 'second', sendable: true }],
  'with no failure in the way, any waiting message can be sent ahead of its turn',
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

// Promotion re-checks at the database what the projection decided for the eye: a
// queue can change between the render and the click.
assert.match(chatDispatch, /Only a message that is still waiting can be sent now\./)
assert.match(chatDispatch, /An earlier message in this conversation needs attention/)
assert.match(
  chatDispatch,
  /position: lowest - 1/,
  'promotion takes the slot below the lowest rather than swapping, because position is unique per thread',
)
assert.match(
  chatDispatch,
  /pg_advisory_xact_lock\(hashtext\('bunkhouse\.chat_dispatch'\), hashtext\(\$\{current\.threadId\}\)\)/,
  'promotion serializes against claiming on the same per-thread lock',
)

console.log('lifecycle: exhaustive person, execution-attempt, dispatch, and queue-UI state matrices verified')
