import { createJobs } from '@braedonsaunders/appkit-jobs'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { schema as identity } from '@braedonsaunders/appkit-db'
import { db } from '../src/db/client'
import { ASSIGNMENT_MAX_STEPS } from '../src/lib/agent-runs'
import { retireContradictedBeliefs } from '../src/lib/stale-beliefs'
import { consolidateMemories } from '../src/lib/memory-consolidation'
import { MAX_SELF_SCHEDULED_REPEATS } from '../src/lib/agent-abilities'
import { approvals, assignments, mailboxAccounts, mailMessages, people, runs, tokenSpend } from '../src/db/schema'
import { sendNewMail, sendReplyInThread, syncPersonMailbox } from '../src/lib/mailbox'
import { dueDuties, executeAgentRun, pendingInboundMessageIds, startRunsForNewInbound } from '../src/lib/agent-runs'
import { finalizeAssignmentRun } from '../src/lib/assignments'
import { executeDueDuty } from '../src/lib/duty-execution'
import { gardenerPass as gardenTenant, journalPass as journalTenant, reflectionPass as reflectTenant } from '../src/lib/consolidation'
import { pendingAssignmentIds, runAssignment } from '../src/lib/assignments'
import { decidedApprovalIds, executeDecidedApproval } from '../src/lib/approval-executor'
import { tidyWorkspaces } from '../src/lib/workspace'
import { syncToolCatalogue, toolHousekeeping, toolsSupported } from '../src/lib/tools'
import { systemsHousekeeping } from '../src/lib/mcp-health'
import { probeAllTrunks, refreshBridgeRegistrations } from '../src/lib/pbx'
import { sweepExpiredRecordings } from '../src/lib/voice-recording'
import { refreshPricesFromOpenRouter } from '../src/lib/pricing'
import { refreshMeasuredVoiceRates } from '../src/lib/voice-pricing'
import { reconcileTenant } from '../src/lib/cost-reconciliation'
import {
  drainChatDispatchQueue,
  pendingChatThreadIds,
  recoverChatDispatches,
} from '../src/lib/chat-dispatch'

// The bunkhouse worker: mailbox sync → inbound runs, the duty scheduler,
// approval execution/resume, assignment runs, and the Logbook consolidation
// jobs — BullMQ on the shared Redis. Heartbeat passes are idempotent; deep
// work (assignments, approval continuations) runs on its own queue so a long
// deliverable never stalls mail sync or the schedulers.

const redisUrl = process.env.BUNKHOUSE_REDIS_URL
if (!redisUrl) throw new Error('BUNKHOUSE_REDIS_URL must be set (run with --env-file=.env.local)')

const jobs = createJobs({ redisUrl })
const app = db()

async function activeTenantIds(): Promise<string[]> {
  const rows = await app.withSuperAdmin((superDb) =>
    superDb
      .select({ id: identity.tenants.id })
      .from(identity.tenants)
      .where(eq(identity.tenants.status, 'active')),
  )
  return rows.map((r) => r.id)
}

async function mailboxPass(): Promise<void> {
  for (const tenantId of await activeTenantIds()) {
    // Errored accounts are swept alongside healthy ones: a mail server that
    // was down at 09:00 is usually back by 09:05, and syncPersonMailbox
    // returns the account to `active` as soon as one pass succeeds. Only
    // `disabled` — the state an operator chose — is left alone.
    const accounts = await app.withTenantContext(tenantId, () =>
      app.db
        .select({ personId: mailboxAccounts.personId, address: mailboxAccounts.address })
        .from(mailboxAccounts)
        .where(inArray(mailboxAccounts.status, ['active', 'error'])),
    )
    for (const account of accounts) {
      try {
        const { saved } = await syncPersonMailbox(tenantId, account.personId)
        if (saved > 0) console.log(`[mailbox] ${account.address}: ${saved} new`)
      } catch (error) {
        console.error(`[mailbox] ${account.address}:`, (error as Error).message)
      }
    }
    for (const messageId of await pendingInboundMessageIds(tenantId)) {
      await deepWork.add('inbound', { kind: 'inbound', tenantId, id: messageId }, { jobId: `inbound-${tenantId}-${messageId}` })
    }
  }
}

async function dutiesPass(): Promise<void> {
  for (const tenantId of await activeTenantIds()) {
    for (const duty of await dueDuties(tenantId)) {
      const scheduledAt = duty.nextDueAt?.toISOString() ?? null
      const occurrence = duty.nextDueAt?.getTime() ?? 0
      await deepWork.add(
        'duty',
        { kind: 'duty', tenantId, id: duty.id, scheduledAt },
        { jobId: `duty-${tenantId}-${duty.id}-${occurrence}` },
      )
    }
  }
}

const APPROVE_WORDS = new Set(['approve', 'approved', 'yes', 'ok', 'okay', 'lgtm'])
const DECLINE_WORDS = new Set(['decline', 'declined', 'reject', 'rejected', 'no', 'deny', 'denied'])

/** Parse the first meaningful word of a reply body (skipping quoted lines). */
function parseDecision(body: string): 'approved' | 'rejected' | null {
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('>') || line.startsWith('On ')) continue
    const word = line.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? ''
    if (APPROVE_WORDS.has(word)) return 'approved'
    if (DECLINE_WORDS.has(word)) return 'rejected'
    return null
  }
  return null
}

/** Email-driven decisions: a staff reply to the [BH#tag] thread decides it. */
async function applyEmailedDecisions(tenantId: string): Promise<void> {
  await app.withTenant(tenantId, async () => {
    const open = await app.db.select().from(approvals).where(eq(approvals.status, 'pending'))
    for (const approval of open) {
      const tag = `[BH#${approval.id.slice(0, 8)}]`
      const replies = await app.db
        .select()
        .from(mailMessages)
        .where(
          and(
            eq(mailMessages.direction, 'inbound'),
            sql`${mailMessages.subject} like ${'%' + tag + '%'}`,
            sql`${mailMessages.sentAt} > ${approval.createdAt}`,
          ),
        )
        .orderBy(mailMessages.sentAt)
      for (const reply of replies) {
        const sender = reply.from.address.toLowerCase()
        const staff = await app.db
          .select({ id: people.id })
          .from(people)
          .where(and(eq(people.status, 'active'), eq(people.kind, 'human'), sql`lower(${people.email}) = ${sender}`))
          .limit(1)
        if (staff.length === 0) continue
        const decision = parseDecision(reply.bodyText)
        if (!decision) continue
        const note = reply.bodyText.split('\n').find((l) => l.trim() && !l.trim().startsWith('>'))?.trim().slice(0, 200) ?? null
        await app.db
          .update(approvals)
          .set({ status: decision, decidedAt: new Date(), decidedById: staff[0]!.id, decisionNote: note })
          .where(and(eq(approvals.id, approval.id), eq(approvals.status, 'pending')))
        console.log(`[approval] ${tag} ${decision} by email from ${sender}`)
        break
      }
    }
  })
}

/**
 * Decided approvals and pending assignments become deep-work jobs. Both are
 * claim-protected (executed_at / pending→working), so re-enqueueing the same
 * id across ticks is a harmless no-op.
 */
async function approvalsPass(): Promise<void> {
  for (const tenantId of await activeTenantIds()) {
    await applyEmailedDecisions(tenantId)
    for (const approvalId of await decidedApprovalIds(tenantId)) {
      await deepWork.add('approval', { kind: 'approval', tenantId, id: approvalId })
    }
  }
}

async function assignmentsPass(): Promise<void> {
  for (const tenantId of await activeTenantIds()) {
    for (const assignmentId of await pendingAssignmentIds(tenantId)) {
      await deepWork.add('assignment', { kind: 'assignment', tenantId, id: assignmentId })
    }
  }
}

async function conversationsPass(): Promise<void> {
  for (const tenantId of await activeTenantIds()) {
    const recovered = await recoverChatDispatches(tenantId)
    if (recovered.completed > 0 || recovered.failed > 0) {
      console.log(`[conversations] tenant ${tenantId}: recovered ${recovered.completed}, needs attention ${recovered.failed}`)
    }
    for (const threadId of await pendingChatThreadIds(tenantId)) {
      await deepWork.add(
        'conversation',
        { kind: 'conversation', tenantId, id: threadId },
      )
    }
  }
}

/**
 * Follow-up discipline for runs waiting on a person: after the configured
 * silence, one polite nudge on the same thread; after the same wait again,
 * the agent is woken with the silence and decides how to proceed. No run
 * waits forever, and nobody gets nagged twice.
 */
async function waitsPass(): Promise<void> {
  const dayMs = 24 * 60 * 60 * 1000
  for (const tenantId of await activeTenantIds()) {
    const waiting = await app.withTenantContext(tenantId, () =>
      app.db.select().from(runs).where(eq(runs.status, 'waiting_reply')),
    )
    for (const run of waiting) {
      const wait = run.waiting
      if (!wait) continue
      const askedAt = new Date(wait.askedAt).getTime()
      const nudgeMs = wait.nudgeAfterDays * dayMs
      try {
        if (!wait.nudgedAt && Date.now() - askedAt >= nudgeMs) {
          await sendReplyInThread({
            tenantId,
            threadId: wait.threadId,
            text: `Just following up on my question below — I'm holding work on this until I hear back. Whenever you get a moment.`,
            runId: run.id,
          })
          await app.withTenant(tenantId, async () => {
            await app.db
              .update(runs)
              .set({ waiting: { ...wait, nudgedAt: new Date().toISOString() } })
              .where(eq(runs.id, run.id))
          })
          console.log(`[waits] nudged ${wait.to} for run ${run.id}`)
        } else if (wait.nudgedAt && Date.now() - new Date(wait.nudgedAt).getTime() >= nudgeMs) {
          const daysWaited = Math.round((Date.now() - askedAt) / dayMs)
          const resumed = await executeAgentRun({
            tenantId,
            personId: run.personId,
            trigger: run.trigger,
            resumeRunId: run.id,
            ...(run.trigger.type === 'assignment' ? { maxSteps: ASSIGNMENT_MAX_STEPS } : {}),
            input: {
              type: 'reply_received',
              question: wait.question,
              askedOf: wait.to,
              reply: null,
              daysWaited,
            },
          })
          if (run.trigger.type === 'assignment') {
            await finalizeAssignmentRun(tenantId, run.trigger.assignmentId, resumed.runId, resumed.outcome)
          }
          console.log(`[waits] no reply from ${wait.to} after ${daysWaited}d — run ${run.id} woken to decide`)
        }
      } catch (error) {
        console.error(`[waits] run ${run.id}:`, (error as Error).message)
      }
    }
  }
}

/**
 * The weekly one-on-one, in writing: every agent with a manager sends a short,
 * honest self-report — counts from the ledgers, never model-invented numbers.
 * At most one per agent per week, keyed off its own outbound mail.
 */
async function weeklyReportPass(): Promise<void> {
  const weekMs = 7 * 24 * 60 * 60 * 1000
  const since = new Date(Date.now() - weekMs)
  for (const tenantId of await activeTenantIds()) {
    const agents = await app.withTenantContext(tenantId, () =>
      app.db
        .select()
        .from(people)
        .where(and(eq(people.kind, 'agent'), eq(people.status, 'active'), sql`${people.reportsToId} is not null`)),
    )
    for (const agent of agents) {
      try {
        const data = await app.withTenantContext(tenantId, async () => {
          const [manager] = await app.db.select().from(people).where(eq(people.id, agent.reportsToId!))
          const [already] = await app.db
            .select({ id: mailMessages.id })
            .from(mailMessages)
            .where(
              and(
                eq(mailMessages.direction, 'outbound'),
                sql`${mailMessages.subject} like 'Weekly report —%'`,
                sql`${mailMessages.from}->>'address' = ${agent.email}`,
                sql`${mailMessages.sentAt} > ${new Date(Date.now() - 6 * 24 * 60 * 60 * 1000)}`,
              ),
            )
            .limit(1)
          const runRows = await app.db
            .select({ status: runs.status, count: sql<number>`count(*)`.mapWith(Number) })
            .from(runs)
            .where(and(eq(runs.personId, agent.id), sql`${runs.startedAt} > ${since}`))
            .groupBy(runs.status)
          const assignmentRows = await app.db
            .select({ status: assignments.status, count: sql<number>`count(*)`.mapWith(Number) })
            .from(assignments)
            .where(and(eq(assignments.personId, agent.id), sql`${assignments.updatedAt} > ${since}`))
            .groupBy(assignments.status)
          const [spend] = await app.db
            .select({ cost: sql<string>`coalesce(sum(${tokenSpend.costUsd}), 0)` })
            .from(tokenSpend)
            .where(and(eq(tokenSpend.personId, agent.id), sql`${tokenSpend.createdAt} > ${since}`))
          return { manager: manager ?? null, already: Boolean(already), runRows, assignmentRows, spend }
        })
        if (!data.manager || data.already) continue
        const runCount = data.runRows.reduce((n, r) => n + r.count, 0)
        if (runCount === 0) continue
        const failed = data.runRows.find((r) => r.status === 'failed')?.count ?? 0
        const waiting = data.runRows.filter((r) => r.status.startsWith('waiting')).reduce((n, r) => n + r.count, 0)
        const delivered = data.assignmentRows.find((r) => r.status === 'delivered')?.count ?? 0
        const stuck = data.assignmentRows.find((r) => r.status === 'failed')?.count ?? 0
        const lines = [
          `Hi ${data.manager.name.split(' ')[0]},`,
          '',
          `My week in numbers: ${runCount} piece${runCount === 1 ? '' : 's'} of work handled` +
            (delivered ? `, ${delivered} deliverable${delivered === 1 ? '' : 's'} shipped` : '') +
            (waiting ? `, ${waiting} item${waiting === 1 ? '' : 's'} waiting on someone` : '') +
            (failed ? `, ${failed} run${failed === 1 ? '' : 's'} failed` : '') +
            `.`,
          ...(stuck
            ? [`${stuck} assignment${stuck === 1 ? '' : 's'} need${stuck === 1 ? 's' : ''} attention — see my Work tab.`]
            : []),
          `Token spend this week: $${Number(data.spend?.cost ?? 0).toFixed(2)}.`,
          '',
          `Full detail is on my profile. Reply if you want anything handled differently.`,
          '',
          agent.personality?.signoff ?? agent.name,
        ]
        await sendNewMail({
          tenantId,
          personId: agent.id,
          to: [{ name: data.manager.name, address: data.manager.email }],
          subject: `Weekly report — ${agent.name}`,
          text: lines.join('\n'),
        })
        console.log(`[reports] ${agent.name} → ${data.manager.name}`)
      } catch (error) {
        console.error(`[reports] ${agent.name}:`, (error as Error).message)
      }
    }
  }
}

/**
 * Phone-system health: a SIP OPTIONS keepalive against every trunk, plus the
 * registration state of any mode-B bridge extensions. Both write status onto
 * the rows the Phone system drawer reads, so a dead trunk is visible before a
 * caller finds it.
 */
async function trunkHealthPass(): Promise<void> {
  for (const tenantId of await activeTenantIds()) {
    try {
      await probeAllTrunks(tenantId)
      await refreshBridgeRegistrations(tenantId)
    } catch (error) {
      console.error(`[pbx] tenant ${tenantId}:`, (error as Error).message)
    }
  }
}

/** Monthly housekeeping over company knowledge: the gardener proposes merges,
 *  retirements, and contradiction fixes for a human to decide. It self-gates to
 *  one pass per tenant per month, so a daily tick is cheap. */
async function gardenerPassAll(): Promise<void> {
  for (const tenantId of await activeTenantIds()) {
    try {
      const { proposed } = await gardenTenant(tenantId)
      if (proposed > 0) console.log(`[gardener] tenant ${tenantId}: ${proposed} housekeeping suggestion(s)`)
    } catch (error) {
      console.error(`[gardener] tenant ${tenantId}:`, (error as Error).message)
    }
  }
}

/** Daily workspace housekeeping — a no-op until a tenant turns retention on. */
async function workspacePass(): Promise<void> {
  for (const tenantId of await activeTenantIds()) {
    try {
      const { deleted } = await tidyWorkspaces(tenantId)
      if (deleted > 0) console.log(`[workspace] tenant ${tenantId}: retired ${deleted} aged file(s)`)
      const recordings = await sweepExpiredRecordings(tenantId)
      if (recordings.deleted > 0) console.log(`[recordings] tenant ${tenantId}: retired ${recordings.deleted}`)
    } catch (error) {
      console.error(`[workspace] tenant ${tenantId}:`, (error as Error).message)
    }
  }
}

/**
 * The tool shelf, kept honest: put the catalogue on every tenant's shelf, let
 * unanswered requests and spent grants lapse, and re-check that installed tools
 * still work. All three are idempotent, so a missed tick costs nothing.
 */
async function toolsPass(): Promise<void> {
  if (!toolsSupported()) return
  for (const tenantId of await activeTenantIds()) {
    try {
      await syncToolCatalogue(tenantId)
      const { expired, checked, degraded } = await toolHousekeeping(tenantId)
      if (expired > 0) console.log(`[tools] tenant ${tenantId}: ${expired} request(s) lapsed`)
      if (degraded > 0) console.log(`[tools] tenant ${tenantId}: ${degraded}/${checked} tool(s) unhealthy`)
    } catch (error) {
      console.error(`[tools] tenant ${tenantId}:`, (error as Error).message)
    }
  }
}

/**
 * The outside systems, kept signed in and watched.
 *
 * An OAuth grant is renewed before it lapses rather than when a duty trips over
 * it: a rotating refresh token is spent by its own use and expires from disuse,
 * so a system nobody touched over a long weekend is a system that cannot sign
 * itself back in. The health check that follows is what makes a dead connection
 * visible on the Systems screen instead of only in the run that needed it.
 */
async function systemsPass(): Promise<void> {
  for (const tenantId of await activeTenantIds()) {
    try {
      const { renewed, checked, failing } = await systemsHousekeeping(tenantId)
      for (const label of renewed) console.log(`[systems] tenant ${tenantId}: renewed ${label} ahead of expiry`)
      for (const failure of failing) console.error(`[systems] tenant ${tenantId}: ${failure}`)
      if (checked > 0 && failing.length === 0) {
        console.log(`[systems] tenant ${tenantId}: ${checked} system(s) answering`)
      }
    } catch (error) {
      console.error(`[systems] tenant ${tenantId}:`, (error as Error).message)
    }
  }
}

/** Nightly journal: episodes + fact candidates from yesterday's runs. The
 *  pass itself skips any run already journaled (episode with its sourceRunId),
 *  so a 6-hour tick only ever adds what the last one missed. */
async function journalPass(): Promise<void> {
  for (const tenantId of await activeTenantIds()) {
    await journalTenant(tenantId)
  }
}

/** Weekly reflection: evidence-cited conclusions + procedure-change proposals.
 *  The pass skips an agent that already has a consolidator reflection from the
 *  last 6 days, so a 12-hour tick fires at most once per agent per week. */
async function reflectionPass(): Promise<void> {
  for (const tenantId of await activeTenantIds()) {
    await reflectTenant(tenantId)
  }
}

/**
 * Abandoned calls: a call page creates its session (and run) before the caller
 * joins the room, so a closed tab, a blocked microphone, or a retry loop
 * leaves 'active' sessions nobody is on. The voice agent finalizes every call
 * it actually answered; this sweep is the babysitter for the ones it never
 * saw. Ten minutes is far beyond any legitimate ring time.
 */
async function callSweepPass(): Promise<void> {
  const swept = await app.withSuperAdmin((superDb) =>
    superDb.execute(sql`
      with stale as (
        update call_sessions set status = 'ended', ended_at = now(), updated_at = now()
        where status = 'active' and started_at < now() - interval '10 minutes'
        returning run_id
      )
      update runs set status = 'failed', finished_at = now(),
        summary = 'Call ended before it was answered.'
      where id in (select run_id from stale where run_id is not null) and status = 'running'
      returning id
    `),
  )
  if (swept.rows.length > 0) console.log(`[calls] swept ${swept.rows.length} abandoned call run(s)`)

  // Meeting invitations nobody opened: once the link expires unjoined, the
  // pre-created session closes so nothing sits 'active' forever.
  const meetings = await app.withSuperAdmin((superDb) =>
    superDb.execute(sql`
      with unopened as (
        update call_sessions cs set status = 'ended', ended_at = now(), updated_at = now()
        from meeting_links ml
        where ml.session_id = cs.id and cs.status = 'active'
          and ml.joined_at is null and ml.expires_at < now()
        returning cs.run_id
      )
      update runs set status = 'completed', finished_at = now(),
        summary = 'Meeting invitation expired without being opened.'
      where id in (select run_id from unopened where run_id is not null) and status = 'running'
      returning id
    `),
  )
  if (meetings.rows.length > 0) console.log(`[calls] closed ${meetings.rows.length} unopened meeting invitation(s)`)
}

/**
 * Sleeping on the day: a logbook of raw episodes becomes the few conclusions
 * worth carrying, and the raw entries are expired out of the way of everything
 * that reads memory in order to work. Never deleted — the day is still there
 * for anyone who goes looking.
 */
async function consolidateMemoriesAll(): Promise<void> {
  for (const tenantId of await activeTenantIds()) {
    const done = await consolidateMemories(tenantId).catch((error: unknown) => {
      console.error(`[memory] ${tenantId}: ${error instanceof Error ? error.message : String(error)}`)
      return []
    })
    for (const one of done) {
      console.log(`[memory] ${one.agent}: ${one.read} episodes became ${one.kept} note(s)`)
    }
  }
}

/**
 * Beliefs the ledger has since disproved.
 *
 * An agent's own logbook has never been gardened — the gardener only ever
 * looked at company-scoped notes — so a note saying a tool is broken lives for
 * ever and is re-read into the top of every run. It shapes the work long after
 * the thing it describes is fixed, and it is self-confirming: an agent that
 * believes it cannot do something does not try, so nothing ever contradicts
 * the note. This is what contradicts it.
 */
async function staleBeliefsPass(): Promise<void> {
  // A repeat an agent booked for itself has to be bounded, and the bound has to
  // apply to the ones already out there — not only to the next one written.
  // Two hourly duties whose titles were "check whether Dana's note has arrived"
  // and "re-check whether Dana's note has arrived" went on firing after the
  // ceiling was added, because the ceiling was only applied at creation and
  // they had already been created. `maxRuns` was always honoured by the
  // scheduler; it was simply never set. Standing enforcement rather than a
  // one-off backfill, so a duty that reaches production without a cap cannot
  // outlive this pass either. Role-pack duties belong to the role and are left
  // alone; this is only what an agent booked for itself.
  const capped = await app.withSuperAdmin((superDb) =>
    superDb.execute(sql`
      update duties set max_runs = ${MAX_SELF_SCHEDULED_REPEATS}, updated_at = now()
      where max_runs is null
        and schedule_kind = 'cron'
        and created_by = person_id
        and from_role_pack_duty is null
      returning id, title, run_count
    `),
  )
  for (const row of capped.rows) {
    console.log(
      `[duties] capped "${row.title}" at ${MAX_SELF_SCHEDULED_REPEATS} runs (it had already fired ${row.run_count})`,
    )
  }

  for (const tenantId of await activeTenantIds()) {
    const retired = await retireContradictedBeliefs(tenantId).catch((error: unknown) => {
      console.error(`[beliefs] ${tenantId}: ${error instanceof Error ? error.message : String(error)}`)
      return []
    })
    for (const belief of retired) {
      console.log(`[beliefs] retired "${belief.note}" for ${belief.agent} — ${belief.tool} has worked since`)
    }
  }
}

/**
 * Work the worker died holding.
 *
 * A run used to be a couple of dozen steps — a few minutes — so a deploy or a
 * crash landing inside one was a narrow window and the loss was small. Runs
 * are now allowed to go on for hours, which is the point, and that turns the
 * same window into the most likely way an assignment quietly disappears: the
 * process goes away mid-run, the run row stays 'running' and the assignment
 * stays 'working', nothing is watching either, and the person who was promised
 * a deliverable never hears another word.
 *
 * The heartbeat is the run's own event stream — every tool call and result
 * appends one. A single tool call is capped well below this, so half an hour
 * of total silence from a 'running' assignment means nobody is at the keyboard.
 * It goes back on the queue to be finished, once. If it dies a second time it
 * is left failed with the reason on it, because something about that work is
 * killing the worker and quietly retrying it forever is how a loop hides.
 */
const CRASH_MARKER = 'The worker stopped mid-run'

async function abandonedWorkPass(): Promise<void> {
  const reclaimed = await app.withSuperAdmin((superDb) =>
    superDb.execute(sql`
      with dead as (
        update runs r set status = 'failed', finished_at = now(),
          summary = 'The worker stopped while this run was working.'
        where r.status = 'running'
          and r.trigger->>'type' = 'assignment'
          and coalesce(
                (select max(e.created_at) from run_events e where e.run_id = r.id),
                r.started_at
              ) < now() - interval '30 minutes'
        returning r.id
      )
      update assignments a
        set status = (case when a.last_error like ${`${CRASH_MARKER}%`} then 'failed' else 'pending' end)::assignment_status,
            last_error = ${`${CRASH_MARKER}; picked up again.`},
            updated_at = now()
      where a.run_id in (select id from dead) and a.status = 'working'
      returning a.id, a.status
    `),
  )
  if (reclaimed.rows.length > 0) {
    const failed = reclaimed.rows.filter((row: { status?: unknown }) => row.status === 'failed').length
    console.log(
      `[work] reclaimed ${reclaimed.rows.length - failed} abandoned assignment(s), gave up on ${failed}`,
    )
  }
}

/**
 * Nightly money pass: keep the fallback price table current, re-measure what
 * speech actually costs, and check both against the invoices the providers are
 * willing to show.
 *
 * None of the three rewrites a spend row. Prices are effective-dated, so a
 * refresh only ever changes what future work is charged at; the reconciliation
 * is a measurement kept beside the ledger, not a correction applied to it.
 * Every step is skippable on its own — a company with no OpenRouter-listed
 * model, no Deepgram key, or no administration key simply has less to do.
 */
async function moneyPass(): Promise<void> {
  for (const tenantId of await activeTenantIds()) {
    try {
      const { updated, unmatched } = await refreshPricesFromOpenRouter(tenantId)
      if (updated.length > 0) console.log(`[prices] tenant ${tenantId}: repriced ${updated.join(', ')}`)
      if (unmatched.length > 0) {
        console.log(`[prices] tenant ${tenantId}: no catalog price for ${unmatched.join(', ')} — needs a manual row`)
      }
    } catch (error) {
      console.error(`[prices] tenant ${tenantId}:`, (error as Error).message)
    }

    try {
      const measured = await refreshMeasuredVoiceRates(tenantId)
      if (measured.ok) {
        console.log(`[speech] tenant ${tenantId}: deepgram $${measured.deepgram.usdPerMinute.toFixed(4)}/min`)
      }
    } catch (error) {
      console.error(`[speech] tenant ${tenantId}:`, (error as Error).message)
    }

    try {
      for (const outcome of await reconcileTenant(tenantId)) {
        if (outcome.message) {
          console.log(`[reconcile] tenant ${tenantId} ${outcome.provider}: ${outcome.message}`)
        } else if (outcome.recorded > 0) {
          console.log(
            `[reconcile] tenant ${tenantId} ${outcome.provider}: ${outcome.recorded} figure(s) moved, gap $${outcome.driftUsd.toFixed(2)}`,
          )
        }
      }
    } catch (error) {
      console.error(`[reconcile] tenant ${tenantId}:`, (error as Error).message)
    }
  }
}

type HeartbeatPass =
  | 'mailbox'
  | 'duties'
  | 'approvals'
  | 'assignments'
  | 'journal'
  | 'reflection'
  | 'calls'
  | 'workspace'
  | 'waits'
  | 'reports'
  | 'gardener'
  | 'trunks'
  | 'money'
  | 'tools'
  | 'systems'
  | 'conversations'
type DeepWorkJob =
  | { kind: 'assignment' | 'approval' | 'inbound' | 'conversation'; tenantId: string; id: string }
  | { kind: 'duty'; tenantId: string; id: string; scheduledAt: string | null }

// Deep work — assignment runs and approval continuations — gets its own queue
// and worker so a multi-minute deliverable never blocks the heartbeat.
const deepWork = jobs.defineQueue<DeepWorkJob>('bunkhouse-deep-work')

const heartbeat = jobs.defineQueue<{ pass: HeartbeatPass }>('bunkhouse-heartbeat')
await heartbeat.upsertJobScheduler('mailbox', { every: 120_000 }, { name: 'tick', data: { pass: 'mailbox' } })
await heartbeat.upsertJobScheduler('duties', { every: 60_000 }, { name: 'tick', data: { pass: 'duties' } })
await heartbeat.upsertJobScheduler('approvals', { every: 30_000 }, { name: 'tick', data: { pass: 'approvals' } })
await heartbeat.upsertJobScheduler('assignments', { every: 30_000 }, { name: 'tick', data: { pass: 'assignments' } })
await heartbeat.upsertJobScheduler('conversations', { every: 30_000 }, { name: 'tick', data: { pass: 'conversations' } })
await heartbeat.upsertJobScheduler('calls', { every: 300_000 }, { name: 'tick', data: { pass: 'calls' } })
await heartbeat.upsertJobScheduler('waits', { every: 3_600_000 }, { name: 'tick', data: { pass: 'waits' } })
await heartbeat.upsertJobScheduler('reports', { every: 21_600_000 }, { name: 'tick', data: { pass: 'reports' } })
await heartbeat.upsertJobScheduler('workspace', { every: 86_400_000 }, { name: 'tick', data: { pass: 'workspace' } })
await heartbeat.upsertJobScheduler('tools', { every: 3_600_000 }, { name: 'tick', data: { pass: 'tools' } })
// Ten minutes: often enough that a one-hour access token is renewed by this
// pass rather than by the duty that needed it, and that a provider refusing is
// news within minutes. The pass itself only calls out when a grant is close to
// expiry or a health reading has gone stale, so most ticks do nothing.
await heartbeat.upsertJobScheduler('systems', { every: 600_000 }, { name: 'tick', data: { pass: 'systems' } })
await heartbeat.upsertJobScheduler('gardener', { every: 86_400_000 }, { name: 'tick', data: { pass: 'gardener' } })
await heartbeat.upsertJobScheduler('trunks', { every: 300_000 }, { name: 'tick', data: { pass: 'trunks' } })
await heartbeat.upsertJobScheduler('journal', { every: 21_600_000 }, { name: 'tick', data: { pass: 'journal' } })
await heartbeat.upsertJobScheduler('reflection', { every: 43_200_000 }, { name: 'tick', data: { pass: 'reflection' } })
// Providers publish yesterday's charges, so a daily pass is as often as there
// is anything new to read.
await heartbeat.upsertJobScheduler('money', { every: 86_400_000 }, { name: 'tick', data: { pass: 'money' } })

const worker = jobs.createWorker<{ pass: HeartbeatPass }>(
  'bunkhouse-heartbeat',
  async (job: { data: { pass: HeartbeatPass } }) => {
    if (job.data.pass === 'mailbox') await mailboxPass()
    else if (job.data.pass === 'duties') await dutiesPass()
    else if (job.data.pass === 'assignments') await assignmentsPass()
    else if (job.data.pass === 'conversations') await conversationsPass()
    else if (job.data.pass === 'calls') {
      await callSweepPass()
      await abandonedWorkPass()
    }
    else if (job.data.pass === 'waits') await waitsPass()
    else if (job.data.pass === 'reports') await weeklyReportPass()
    else if (job.data.pass === 'workspace') await workspacePass()
    else if (job.data.pass === 'tools') await toolsPass()
    else if (job.data.pass === 'systems') await systemsPass()
    else if (job.data.pass === 'gardener') {
      await gardenerPassAll()
      await staleBeliefsPass()
      await consolidateMemoriesAll()
    }
    else if (job.data.pass === 'trunks') await trunkHealthPass()
    else if (job.data.pass === 'journal') await journalPass()
    else if (job.data.pass === 'reflection') await reflectionPass()
    else if (job.data.pass === 'money') await moneyPass()
    else await approvalsPass()
  },
  { concurrency: 1 },
)

const deepWorker = jobs.createWorker<DeepWorkJob>(
  'bunkhouse-deep-work',
  async (job: { data: DeepWorkJob }) => {
    if (job.data.kind === 'assignment') {
      await runAssignment(job.data.tenantId, job.data.id)
    } else if (job.data.kind === 'approval') {
      await executeDecidedApproval(job.data.tenantId, job.data.id)
    } else if (job.data.kind === 'inbound') {
      await startRunsForNewInbound(job.data.tenantId, job.data.id)
    } else if (job.data.kind === 'conversation') {
      await drainChatDispatchQueue({ tenantId: job.data.tenantId, threadId: job.data.id })
    } else if (job.data.kind === 'duty') {
      await executeDueDuty(job.data.tenantId, job.data.id, job.data.scheduledAt)
    }
  },
  { concurrency: 2 },
)

await heartbeat.add('tick', { pass: 'mailbox' })
await heartbeat.add('tick', { pass: 'duties' })
await heartbeat.add('tick', { pass: 'approvals' })
await heartbeat.add('tick', { pass: 'assignments' })
await heartbeat.add('tick', { pass: 'conversations' })
// Queued at boot as well as daily: this is the pass that retires a belief the
// ledger has disproved and caps a runaway repeat, and both of those are worth
// correcting when a deploy lands rather than up to a day later. The gardener it
// rides with is period-gated internally, so this costs nothing extra.
await heartbeat.add('tick', { pass: 'gardener' })
// A deploy is exactly when a grant may have been sitting unused; check on boot
// rather than up to ten minutes later.
await heartbeat.add('tick', { pass: 'systems' })
console.log(
  'bunkhouse worker up — mailbox 2m, duties 1m, approvals 30s, assignments 30s, call sweep 5m, systems 10m, journal 6h, reflection 12h, money 24h; deep-work queue ×2 (initial passes queued)',
)

async function shutdown(): Promise<void> {
  await worker.close()
  await deepWorker.close()
  await jobs.closeJobConnections()
  await app.pool.end()
  await app.superPool.end()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
