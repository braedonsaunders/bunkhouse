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

// These contracts must remain production boundaries, not test-only diagrams.
const organizationActions = readFileSync(new URL('../src/app/organization/actions.ts', import.meta.url), 'utf8')
const runExecution = readFileSync(new URL('../src/lib/run-execution.ts', import.meta.url), 'utf8')
const chatDispatch = readFileSync(new URL('../src/lib/chat-dispatch.ts', import.meta.url), 'utf8')
const chatWorkspace = readFileSync(new URL('../src/components/chat-workspace.tsx', import.meta.url), 'utf8')
assert.match(organizationActions, /assertPersonStatusTransition/)
assert.match(runExecution, /assertRunAttemptTransition/)
assert.match(chatDispatch, /assertChatDispatchTransition/)
assert.match(chatWorkspace, /chatQueueUiProjection/)

console.log('lifecycle: exhaustive person, execution-attempt, dispatch, and queue-UI state matrices verified')
