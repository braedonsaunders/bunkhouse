import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  citeProcedureAbility,
  DEFAULT_MODEL_INACTIVITY_DEADLINE_MS,
  defineAbility,
  governedToolSet,
  takeAbilityFrame,
  TOOL_FAILURE_LIMIT,
  type Ability,
  type ActionCategory,
  type AutonomyLevel,
  type GovernanceState,
  type ExternalEffectGate,
} from '@bunkhouse/runtime'
import { z } from 'zod'
import { PersonNotWorkingError, isPersonNotWorking, workRefusal, type WorkCandidate } from '../src/lib/person-work'
import {
  APPROVAL_MAX_ATTEMPTS,
  planApprovalExecution,
  settlementAfterFailure,
} from '../src/lib/approval-execution'

// The autonomy dial is enforced in the runtime, not in prompts — this file is
// the proof. Every claim the README makes about governance ('forbidden' blocks,
// 'approval' parks, 'notify' reports, citations pin versions) is asserted here
// against the real governedToolSet, with the model taken out of the loop.

type SinkEvent = Parameters<Parameters<typeof governedToolSet>[0]['sink']['event']>[0]

function harness(args: {
  levels: Partial<Record<ActionCategory, AutonomyLevel>>
  abilities: Ability[]
  deadlineMs?: number
  signal?: AbortSignal
  effects?: ExternalEffectGate
}) {
  const events: SinkEvent[] = []
  const requests: { category: ActionCategory; description: string; action: Record<string, unknown> }[] = []
  const state: GovernanceState = { pendingApprovalId: null, pendingCredentialRequestId: null, pendingWait: null }
  const tools = governedToolSet({
    abilities: args.abilities,
    // Missing categories default to 'approval' — the documented safe posture.
    autonomy: (category) => args.levels[category] ?? 'approval',
    approvals: {
      request: async ({ category, description, action }) => {
        requests.push({ category, description, action })
        return { approvalId: `appr-${requests.length}` }
      },
    },
    sink: {
      event: async (event) => {
        events.push(event)
      },
      spend: async () => {},
    },
    state,
    ...(args.deadlineMs ? { deadlineMs: args.deadlineMs } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
    ...(args.effects ? { effects: args.effects } : {}),
  })
  return { tools, events, requests, state }
}

// --- one model step cannot create approvals that race the same run ---------
{
  const first = defineAbility({
    name: 'metered_search',
    description: 'first read',
    category: 'money_adjacent',
    inputSchema: z.object({ query: z.string() }),
    execute: async () => ({ shouldNotRun: true }),
  })
  const second = defineAbility({
    name: 'metered_profile',
    description: 'second read',
    category: 'money_adjacent',
    inputSchema: z.object({ handle: z.string() }),
    execute: async () => ({ shouldNotRun: true }),
  })
  const { tools, requests, state } = harness({
    levels: { money_adjacent: 'approval' },
    abilities: [first, second],
  })
  const results = await Promise.all([
    tools.metered_search!.execute!({ query: '$RKLB' }, { toolCallId: 'call-search', messages: [] }),
    tools.metered_profile!.execute!({ handle: 'elonmusk' }, { toolCallId: 'call-profile', messages: [] }),
  ]) as Array<{ status: string; approvalId: string }>
  assert.equal(requests.length, 1, 'parallel siblings open one resumable approval, never two competing cards')
  assert.equal(requests[0]?.action.toolCallId, 'call-search', 'the SDK invocation identity is durable approval provenance')
  assert.equal(results.filter((result) => result.status === 'pending_approval').length, 1)
  assert.equal(results.filter((result) => result.status === 'approval_deferred').length, 1)
  assert.equal(state.pendingApprovalId, 'appr-1')
}

// --- governed effects are intended before the adapter executes -------------
{
  const order: string[] = []
  const effects: ExternalEffectGate = {
    execute: async ({ toolName, idempotencyKey, idempotencyScope, operation, signal }) => {
      order.push(`intent:${toolName}:${idempotencyScope}:${idempotencyKey}`)
      const result = await operation(signal)
      order.push('outcome')
      return result
    },
  }
  const { tools } = harness({
    levels: { external_email: 'trusted' },
    effects,
    abilities: [ability({ onExecute: () => order.push('adapter') })],
  })
  await call(tools, 'send_email', { to: 'a@b.test' })
  assert.deepEqual(order, ['intent:send_email:invocation:t1', 'adapter', 'outcome'])
}

// Identical requested actions are still distinct model invocations. The SDK
// call id—not a request hash—is the default identity handed to persistence.
{
  const identities: string[] = []
  const effects: ExternalEffectGate = {
    execute: async ({ idempotencyKey, idempotencyScope, operation, signal }) => {
      identities.push(`${idempotencyScope}:${idempotencyKey}`)
      return operation(signal)
    },
  }
  const { tools } = harness({
    levels: { external_email: 'trusted' },
    effects,
    abilities: [ability({})],
  })
  await call(tools, 'send_email', { to: 'same@b.test' }, 'call-one')
  await call(tools, 'send_email', { to: 'same@b.test' }, 'call-two')
  assert.deepEqual(identities, ['invocation:call-one', 'invocation:call-two'])
}

// A connector can name the destination operation more precisely than the SDK
// invocation, and the gate is told that the key is domain-owned.
{
  const identities: string[] = []
  const effects: ExternalEffectGate = {
    execute: async ({ idempotencyKey, idempotencyScope, operation, signal }) => {
      identities.push(`${idempotencyScope}:${idempotencyKey}`)
      return operation(signal)
    },
  }
  const { tools } = harness({
    levels: { external_email: 'trusted' },
    effects,
    abilities: [ability({ externalEffectKey: (input: { to: string }) => `provider-message:${input.to}` })],
  })
  await call(tools, 'send_email', { to: 'stable@b.test' }, 'sdk-call-that-may-change')
  assert.deepEqual(identities, ['domain:provider-message:stable@b.test'])
}

// --- cancellation reaches an in-flight tool, not only the next step --------
{
  const controller = new AbortController()
  let observedAbort = false
  const slow = defineAbility({
    name: 'slow_write',
    description: 'wait until cancelled',
    category: 'record_write',
    inputSchema: z.object({}),
    execute: async (_input, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            observedAbort = signal.aborted
            reject(signal.reason)
          },
          { once: true },
        )
      }),
  })
  const { tools } = harness({ levels: { record_write: 'trusted' }, abilities: [slow], signal: controller.signal })
  const pending = call(tools, 'slow_write', {})
  controller.abort(new Error('operator cancelled'))
  await assert.rejects(pending, /operator cancelled/)
  assert.equal(observedAbort, true, 'the adapter receives the cancellation signal')
}

function ability(over: Partial<Parameters<typeof defineAbility>[0]> & { onExecute?: () => void }): Ability {
  const { onExecute, ...rest } = over
  return defineAbility({
    name: 'send_email',
    description: 'send an email',
    category: 'external_email',
    inputSchema: z.object({ to: z.string() }),
    execute: async () => {
      onExecute?.()
      return { sent: true }
    },
    ...rest,
  })
}

async function call(
  tools: ReturnType<typeof governedToolSet>,
  name: string,
  input: unknown,
  toolCallId = 't1',
  options: Record<string, unknown> = {},
) {
  const tool = tools[name]
  assert.ok(tool?.execute, `${name} is in the governed set and executable`)
  return tool.execute!(input as never, { toolCallId, messages: [], ...options })
}

// The model SDK owns a per-invocation signal in addition to the run's signal.
// Losing it allowed a timed-out tool to keep writing after the run had closed.
{
  const controller = new AbortController()
  let observedAbort = false
  const slow = defineAbility({
    name: 'late_shell',
    description: 'must stop with its model step',
    category: 'sandbox',
    inputSchema: z.object({}),
    execute: async (_input, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            observedAbort = true
            reject(signal.reason)
          },
          { once: true },
        )
      }),
  })
  const { tools } = harness({ levels: { sandbox: 'trusted' }, abilities: [slow] })
  const pending = call(tools, 'late_shell', {}, 'late-call', { abortSignal: controller.signal })
  controller.abort(new Error('model step expired'))
  const result = (await pending) as { error?: string }
  assert.equal(observedAbort, true, 'the adapter receives the SDK invocation cancellation')
  assert.match(result.error ?? '', /model step expired/, 'the cancelled invocation cannot escape as background work')
}

// --- forbidden blocks in the runtime ----------------------------------------
{
  let executed = false
  const { tools } = harness({
    levels: { external_email: 'forbidden' },
    abilities: [ability({ onExecute: () => (executed = true) })],
  })
  const result = (await call(tools, 'send_email', { to: 'a@b.test' })) as { status?: string }
  assert.equal(result.status, 'forbidden', 'forbidden dial returns a refusal result')
  assert.equal(executed, false, 'forbidden dial never runs the tool body')
}

// --- approval files a request and parks the run -----------------------------
{
  let executed = false
  const { tools, events, requests, state } = harness({
    levels: { external_email: 'approval' },
    abilities: [ability({ onExecute: () => (executed = true) })],
  })
  const result = (await call(tools, 'send_email', { to: 'a@b.test' })) as {
    status?: string
    approvalId?: string
  }
  assert.equal(executed, false, 'approval dial does not run the tool before sign-off')
  assert.equal(result.status, 'pending_approval')
  assert.equal(result.approvalId, 'appr-1')
  assert.equal(state.pendingApprovalId, 'appr-1', 'the loop is flagged to suspend on the approval')
  assert.equal(requests.length, 1, 'exactly one approval request filed')
  assert.equal(requests[0]!.category, 'external_email')
  const evt = events.find((e) => e.kind === 'approval_request')
  assert.ok(evt, 'the approval request is on the run ledger')
}

// --- an unconfigured category defaults to approval, not to trust ------------
{
  let executed = false
  const { tools, state } = harness({
    levels: {}, // nobody configured anything
    abilities: [ability({ onExecute: () => (executed = true) })],
  })
  const result = (await call(tools, 'send_email', { to: 'a@b.test' })) as { status?: string }
  assert.equal(result.status, 'pending_approval', 'day-one posture is conservative')
  assert.equal(executed, false)
  assert.ok(state.pendingApprovalId)
}

// --- notify executes and leaves a record ------------------------------------
{
  let executed = false
  const { tools, events } = harness({
    levels: { external_email: 'notify' },
    abilities: [ability({ onExecute: () => (executed = true) })],
  })
  const result = (await call(tools, 'send_email', { to: 'a@b.test' })) as { sent?: boolean }
  assert.equal(executed, true, 'notify proceeds')
  assert.equal(result.sent, true)
  const note = events.find((e) => e.kind === 'message' && e.text.includes('notify-level'))
  assert.ok(note, 'notify leaves its record for the manager feed')
}

// --- trusted executes silently ----------------------------------------------
{
  const { tools, events, requests } = harness({
    levels: { external_email: 'trusted' },
    abilities: [ability({})],
  })
  const result = (await call(tools, 'send_email', { to: 'a@b.test' })) as { sent?: boolean }
  assert.equal(result.sent, true)
  assert.equal(requests.length, 0)
  assert.equal(events.length, 0, 'trusted files nothing')
}

// --- ungoverned (read-only) abilities run regardless of dials ---------------
{
  const { tools } = harness({
    levels: { external_email: 'forbidden' },
    abilities: [
      defineAbility({
        name: 'read_page',
        description: 'read',
        category: null,
        inputSchema: z.object({}),
        execute: async () => ({ ok: true }),
      }),
    ],
  })
  const result = (await call(tools, 'read_page', {})) as { ok?: boolean }
  assert.equal(result.ok, true, 'a null category has no dial to consult')
}

// --- the category can depend on what is being asked for ---------------------
// The incident that motivated this: mail to a colleague was governed by the
// external dial purely because of which tool the model reached for.
{
  const calls: string[] = []
  const routed = defineAbility({
    name: 'send_email',
    description: 'send',
    category: (input: { to: string }) =>
      input.to.endsWith('@company.test') ? 'internal_email' : 'external_email',
    inputSchema: z.object({ to: z.string() }),
    execute: async ({ to }) => {
      calls.push(to)
      return { sent: true }
    },
  })
  const { tools } = harness({
    levels: { internal_email: 'trusted', external_email: 'forbidden' },
    abilities: [routed],
  })
  const internal = (await call(tools, 'send_email', { to: 'dana@company.test' })) as { sent?: boolean }
  assert.equal(internal.sent, true, 'mail to a colleague rides the internal dial')
  const external = (await call(tools, 'send_email', { to: 'x@elsewhere.test' })) as { status?: string }
  assert.equal(external.status, 'forbidden', 'the same tool to a stranger rides the external dial')
  assert.deepEqual(calls, ['dana@company.test'], 'only the permitted send ran')
}

// --- 'continues' abilities are allowed through an approval dial -------------
// but the dial still decides whether they may run at all.
{
  let steps = 0
  const continues = defineAbility({
    name: 'browser_click',
    description: 'continue an approved browser errand',
    category: 'desktop',
    approval: 'continues',
    inputSchema: z.object({}),
    execute: async () => {
      steps += 1
      return { ok: true }
    },
  })
  const allowed = harness({ levels: { desktop: 'approval' }, abilities: [continues] })
  const step = (await call(allowed.tools, 'browser_click', {})) as { ok?: boolean }
  assert.equal(step.ok, true, "'continues' files no request of its own under an approval dial")
  assert.equal(allowed.requests.length, 0)
  const blocked = harness({ levels: { desktop: 'forbidden' }, abilities: [continues] })
  const refusal = (await call(blocked.tools, 'browser_click', {})) as { status?: string }
  assert.equal(refusal.status, 'forbidden', "forbidden still blocks a 'continues' ability outright")
  assert.equal(steps, 1)
}

// --- a throwing tool comes back as a result, never as silence ---------------
{
  const boom = defineAbility({
    name: 'flaky',
    description: 'fails',
    category: null,
    inputSchema: z.object({}),
    execute: async () => {
      throw new Error('upstream refused')
    },
  })
  const { tools } = harness({ levels: {}, abilities: [boom] })
  const result = (await call(tools, 'flaky', {})) as { error?: string; note?: string }
  assert.match(result.error ?? '', /upstream refused/, 'the failure reason reaches the model')
  assert.ok(result.note, 'and it is told to say so plainly')
}

// --- the breaker refuses a tool that keeps failing the same way -------------
{
  let attempts = 0
  const broken = defineAbility({
    name: 'file_store',
    description: 'always down',
    category: null,
    inputSchema: z.object({ n: z.number() }),
    execute: async () => {
      attempts += 1
      throw new Error('store unreachable')
    },
  })
  const { tools } = harness({ levels: {}, abilities: [broken] })
  for (let i = 0; i < TOOL_FAILURE_LIMIT; i += 1) await call(tools, 'file_store', { n: i })
  const refused = (await call(tools, 'file_store', { n: 99 })) as { note?: string }
  assert.equal(attempts, TOOL_FAILURE_LIMIT, 'no attempt is paid for past the limit')
  assert.match(refused.note ?? '', /will not be tried again/)
}

// --- every tool call is bounded by the deadline ------------------------------
{
  const slow = defineAbility({
    name: 'dns_lookup',
    description: 'never settles',
    category: null,
    inputSchema: z.object({}),
    execute: () => new Promise(() => {}),
  })
  const { tools } = harness({ levels: {}, abilities: [slow], deadlineMs: 50 })
  const result = (await call(tools, 'dns_lookup', {})) as { error?: string }
  assert.match(result.error ?? '', /did not finish within/, 'a wedged tool becomes an error result')
}

// --- procedure citations are recorded with the pinned version ---------------
{
  const events: SinkEvent[] = []
  const cite = citeProcedureAbility({
    sink: {
      event: async (e) => {
        events.push(e)
      },
      spend: async () => {},
    },
    // The run bound version 3 at start; a later edit to the procedure must not
    // change what this run cites.
    procedures: [{ slug: 'dunning-cadence', version: 3 }],
  })
  const { tools } = harness({ levels: {}, abilities: [cite] })
  const cited = (await call(tools, 'cite_procedure', { slug: 'dunning-cadence' })) as { cited?: boolean }
  assert.equal(cited.cited, true)
  const evt = events.find((e) => e.kind === 'procedure_citation')
  assert.ok(evt && evt.kind === 'procedure_citation')
  assert.equal(evt.version, 3, 'the citation carries the version the run actually followed')
  const unknown = (await call(tools, 'cite_procedure', { slug: 'not-assigned' })) as { cited?: boolean }
  assert.equal(unknown.cited, false, 'an unassigned procedure cannot be cited')
  assert.equal(
    events.filter((e) => e.kind === 'procedure_citation').length,
    1,
    'no event for the unknown slug',
  )
}

// --- ability frames become images, never base-64 walls ----------------------
{
  const shot = { mediaType: 'image/jpeg', data: 'aGVsbG8=', label: 'the page after the click' }
  const { frame, rest } = takeAbilityFrame({ ok: true, screenshot: shot })
  assert.deepEqual(frame, shot, 'the frame is lifted out of the result')
  assert.deepEqual(rest, { ok: true }, 'the rest of the result travels unchanged')
  const plain = takeAbilityFrame({ ok: true })
  assert.equal(plain.frame, null)
}

console.log('governance: autonomy dial, approvals, breaker, deadline, citations — all enforced in the runtime')

// ===========================================================================
// Employment is a runtime rule, not a UI one.
//
// An operator offboarded an agent at 13:05 and it executed 51 more runs
// between 13:08 and 17:34, because nothing outside the roster screen ever read
// `status`. AGENTS.md: lifecycle states are "enforced at the domain/service and
// API boundaries, not only by hiding UI".
// ===========================================================================

const src = (file: string): string => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')

// Long work is made of however many active steps it needs. The model guard is
// silence-based, not a total duration cap that can cut off a healthy tool call
// and recycle an earlier progress sentence as the answer.
{
  assert.equal(DEFAULT_MODEL_INACTIVITY_DEADLINE_MS, 30 * 60_000, 'the default tolerates a slow provider')
  const loop = src('../../../packages/runtime/src/loop.ts')
  assert.ok(loop.includes('timeout: { chunkMs:'), 'model liveness resets whenever another chunk arrives')
  assert.ok(!loop.includes('timeout: { stepMs:'), 'there is no wall-clock deadline on a whole model/tool step')
  assert.ok(loop.includes('if (streamAborted)'), 'an aborted stream cannot be finalized from an earlier message')
}

function agent(over: Partial<WorkCandidate>): WorkCandidate {
  return { kind: 'agent', status: 'active', name: 'Bill McDonald', ...over }
}

// --- who may work, and whether waiting could change the answer --------------
{
  assert.equal(workRefusal(agent({})), null, 'an active agent works')

  const retired = workRefusal(agent({ status: 'offboarded' }))
  assert.ok(retired, 'an offboarded agent may not start work — this is the whole of bug 1')
  assert.equal(retired.permanent, true, 'and no amount of waiting changes it: a rehire is a human decision')
  assert.match(retired.reason, /offboarded/, 'the refusal says why, in words an operator reads')

  const hiring = workRefusal(agent({ status: 'onboarding' }))
  assert.ok(hiring, 'an agent still being onboarded may not work either — it is not configured yet')
  assert.equal(hiring.permanent, false, 'but that one resolves when a human finishes onboarding')

  assert.ok(workRefusal(agent({ kind: 'human' })), 'a human colleague is never run as an employee')
  assert.equal(workRefusal(agent({ kind: 'human' }))!.permanent, true)
}

// --- the refusal is a distinct kind of failure, so queues can tell ----------
{
  const error = new PersonNotWorkingError('p-1', { reason: 'gone', permanent: true }, 'run-9')
  assert.ok(isPersonNotWorking(error), 'a refusal is recognisable to whatever was holding the work')
  assert.equal(error.runId, 'run-9', 'and it carries the run row that recorded it')
  assert.equal(isPersonNotWorking(new Error('gone')), false, 'an ordinary failure is not a refusal — it may be retried')
}

// --- ONE door, and the gate is on it ----------------------------------------
// The rule is worth nothing if a second path can open a run around it.
{
  const runs = src('../src/lib/agent-runs.ts')
  const engine = runs.slice(runs.indexOf('export async function executeAgentRun'))
  assert.ok(engine.includes('workRefusal(person)'), 'executeAgentRun consults the employment gate')
  assert.ok(
    engine.indexOf('workRefusal(person)') < engine.indexOf('.insert(runs)'),
    'and consults it BEFORE it opens a run row — a stood-down agent never gets one',
  )

  // Every surface that puts an agent to work goes through that door rather
  // than writing its own run.
  for (const file of [
    '../src/lib/duty-execution.ts',
    '../src/lib/assignments.ts',
    '../src/lib/approval-executor.ts',
    '../src/lib/chat-threads.ts',
    '../src/lib/chat-bridge.ts',
    '../src/lib/call-worker.ts',
  ]) {
    const source = src(file)
    assert.ok(source.includes('executeAgentRun'), `${file} starts work through executeAgentRun`)
    assert.ok(!source.includes('.insert(runs)'), `${file} does not open a run of its own around the gate`)
  }

  // And every queue that had work for a retired agent settles its OWN record
  // with the reason, rather than letting the refusal surface as a crash and
  // re-queue for ever. The approval executor settles through its plan, proved
  // separately below.
  for (const file of [
    '../src/lib/agent-runs.ts', // the inbound-mail sweep
    '../src/lib/duty-execution.ts',
    '../src/lib/assignments.ts',
    '../src/lib/chat-threads.ts',
    '../src/lib/chat-bridge.ts',
  ]) {
    assert.ok(src(file).includes('isPersonNotWorking'), `${file} settles its own record when the gate refuses`)
  }

  // The two places that legitimately open a run row before any work reaches
  // the engine — a call session exists before the caller speaks — ask the same
  // question rather than restating it.
  assert.ok(src('../src/app/call/actions.ts').includes('workRefusal(person)'), 'starting a web call asks the gate')
  assert.ok(src('../scripts/voice-agent.mts').includes('workRefusal(person)'), 'an inbound call asks the gate')
}

// --- work already queued for a retired agent goes with them ------------------
{
  const offboarding = src('../src/app/organization/actions.ts')
  const windDown = offboarding.slice(
    offboarding.indexOf('async function windDownOffboarded'),
    offboarding.indexOf('async function recordStatusTransition'),
  )
  assert.ok(windDown.includes('executedAt: now'), 'a decision not yet carried out is stamped, not left to be replayed')
  assert.ok(
    windDown.includes("'cancelled'") && windDown.includes('Stopped when the agent was offboarded.'),
    'and a run in flight is stopped saying so, rather than discarded',
  )
}

console.log('governance: only an active agent may start work, and every door asks the same question')

// ===========================================================================
// A decided approval is bounded (bug 2). 196 attempts on one rejected
// approval, 144–147 on four others, because nothing counted and 'failed' was
// in the retry set.
// ===========================================================================

const parked = { status: 'waiting_approval' as const }
const closed = { status: 'completed' as const }

// --- a refusal is delivered, not re-run -------------------------------------
{
  const plan = planApprovalExecution({ attempts: 1, decision: 'rejected', run: closed, person: agent({}) })
  assert.deepEqual(
    plan,
    { do: 'deliver_refusal' },
    'declining a request whose run has closed says so on that run — it does not start fresh work to say "no"',
  )

  const stillParked = planApprovalExecution({ attempts: 1, decision: 'rejected', run: parked, person: agent({}) })
  assert.deepEqual(
    stillParked,
    { do: 'continue', resume: true },
    'a run still waiting on the decision is resumed, so the agent can adjust',
  )
}

// --- an approval is still carried out, both ways ----------------------------
{
  assert.deepEqual(
    planApprovalExecution({ attempts: 1, decision: 'approved', run: parked, person: agent({}) }),
    { do: 'continue', resume: true },
    'an approved action resumes the parked run',
  )
  assert.deepEqual(
    planApprovalExecution({ attempts: 1, decision: 'approved', run: closed, person: agent({}) }),
    { do: 'continue', resume: false },
    'and a run that already ended (a call) still gets its follow-up — that behaviour is not the bug',
  )
}

// --- a retired agent's decisions stop, on the first attempt -----------------
{
  for (const decision of ['approved', 'rejected'] as const) {
    const plan = planApprovalExecution({
      attempts: 1,
      decision,
      run: parked,
      person: agent({ status: 'offboarded' }),
    })
    assert.equal(plan.do, 'give_up', `a ${decision} approval for an offboarded agent is given up on immediately`)
    assert.match(plan.do === 'give_up' ? plan.reason : '', /offboarded/, 'and the record says why')
  }
  // Including a rehire: the unfinished business of a previous employment does
  // not resume when somebody is onboarded again.
  assert.equal(
    planApprovalExecution({ attempts: 1, decision: 'approved', run: parked, person: agent({ status: 'onboarding' }) })
      .do,
    'give_up',
  )
  assert.equal(
    planApprovalExecution({ attempts: 1, decision: 'approved', run: parked, person: null }).do,
    'give_up',
    'an agent that no longer exists is not retried either',
  )
  assert.equal(planApprovalExecution({ attempts: 1, decision: 'approved', run: null, person: agent({}) }).do, 'give_up')
}

// --- the cap stops the retry, and records why -------------------------------
{
  for (let attempt = 1; attempt <= APPROVAL_MAX_ATTEMPTS; attempt += 1) {
    assert.notEqual(
      planApprovalExecution({ attempts: attempt, decision: 'approved', run: parked, person: agent({}) }).do,
      'give_up',
      `attempt ${attempt} of ${APPROVAL_MAX_ATTEMPTS} is still allowed`,
    )
  }
  const over = planApprovalExecution({
    attempts: APPROVAL_MAX_ATTEMPTS + 1,
    decision: 'approved',
    run: parked,
    person: agent({}),
  })
  assert.equal(over.do, 'give_up', 'past the cap, nothing further is attempted')
  assert.match(over.do === 'give_up' ? over.reason : '', new RegExp(`${APPROVAL_MAX_ATTEMPTS} attempts`))
}

// --- and a failure that keeps failing terminates -----------------------------
// The worker, simulated: each pass claims (attempts + 1) and the work throws.
// Before the cap this ran for seventeen hours.
{
  let attempts = 0
  let terminal = false
  let recorded = ''
  for (let pass = 0; pass < 200 && !terminal; pass += 1) {
    attempts += 1
    const settlement = settlementAfterFailure(attempts, 'the model provider refused')
    terminal = settlement.terminal
    recorded = settlement.error
  }
  assert.equal(terminal, true, 'a permanently failing approval reaches a terminal state')
  assert.equal(attempts, APPROVAL_MAX_ATTEMPTS, 'after exactly the capped number of attempts, not 196')
  assert.match(recorded, /Gave up after 5 attempts/, 'and the operator is told it was given up on')
  assert.match(recorded, /the model provider refused/, 'with the failure that caused it')

  const early = settlementAfterFailure(1, 'a worker restarted')
  assert.equal(early.terminal, false, 'a transient failure is still picked up again — recovery is why retries exist')
  assert.equal(early.error, 'a worker restarted')
}

// --- the trap: 'failed' is NOT a stop; only executed_at is ------------------
{
  const executor = src('../src/lib/approval-executor.ts')
  const selector = executor.slice(executor.indexOf('export async function decidedApprovalIds'))
  assert.ok(
    selector.includes("eq(approvals.executionStatus, 'failed')"),
    "'failed' is deliberately inside the retry set — a worker that died halfway must be picked up",
  )
  const retryable = executor.slice(
    executor.indexOf('async function settleRetryable'),
    executor.indexOf('export async function decidedApprovalIds'),
  )
  assert.ok(!retryable.includes('executedAt'), 'so settling retryable must NOT stamp executed_at')
  const terminal = executor.slice(
    executor.indexOf('async function settleTerminal'),
    executor.indexOf('async function settleRetryable'),
  )
  assert.ok(terminal.includes('executedAt: new Date()'), 'and only the terminal settlement does — that is the stop')
}

console.log('governance: a decided approval is delivered once, capped at 5 attempts, and never retried for ever')
