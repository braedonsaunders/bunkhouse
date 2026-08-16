import assert from 'node:assert/strict'
import {
  citeProcedureAbility,
  defineAbility,
  governedToolSet,
  takeAbilityFrame,
  TOOL_FAILURE_LIMIT,
  type Ability,
  type ActionCategory,
  type AutonomyLevel,
  type GovernanceState,
} from '@bunkhouse/runtime'
import { z } from 'zod'

// The autonomy dial is enforced in the runtime, not in prompts — this file is
// the proof. Every claim the README makes about governance ('forbidden' blocks,
// 'approval' parks, 'notify' reports, citations pin versions) is asserted here
// against the real governedToolSet, with the model taken out of the loop.

type SinkEvent = Parameters<Parameters<typeof governedToolSet>[0]['sink']['event']>[0]

function harness(args: {
  levels: Partial<Record<ActionCategory, AutonomyLevel>>
  abilities: Ability[]
  deadlineMs?: number
}) {
  const events: SinkEvent[] = []
  const requests: { category: ActionCategory; description: string }[] = []
  const state: GovernanceState = { pendingApprovalId: null, pendingWait: null }
  const tools = governedToolSet({
    abilities: args.abilities,
    // Missing categories default to 'approval' — the documented safe posture.
    autonomy: (category) => args.levels[category] ?? 'approval',
    approvals: {
      request: async ({ category, description }) => {
        requests.push({ category, description })
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
  })
  return { tools, events, requests, state }
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

async function call(tools: ReturnType<typeof governedToolSet>, name: string, input: unknown) {
  const tool = tools[name]
  assert.ok(tool?.execute, `${name} is in the governed set and executable`)
  return tool.execute!(input as never, { toolCallId: 't1', messages: [] })
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
