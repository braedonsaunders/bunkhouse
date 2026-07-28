import { createJobs } from '@appkit/jobs'
import { and, eq, sql } from 'drizzle-orm'
import { schema as identity } from '@appkit/db'
import { db } from '../src/db/client'
import { approvals, assignments, mailboxAccounts, mailMessages, people, runs, tokenSpend } from '../src/db/schema'
import { sendNewMail, sendReplyInThread, syncPersonMailbox } from '../src/lib/mailbox'
import { dueDuties, executeAgentRun, markDutyRun, startRunsForNewInbound } from '../src/lib/agent-runs'
import { finalizeAssignmentRun } from '../src/lib/assignments'
import { nextOccurrence } from '../src/lib/duties'
import { gardenerPass as gardenTenant, journalPass as journalTenant, reflectionPass as reflectTenant } from '../src/lib/consolidation'
import { pendingAssignmentIds, runAssignment } from '../src/lib/assignments'
import { decidedApprovalIds, executeDecidedApproval } from '../src/lib/approval-executor'
import { tidyWorkspaces } from '../src/lib/workspace'
import { probeAllTrunks, refreshBridgeRegistrations } from '../src/lib/pbx'
import { sweepExpiredRecordings } from '../src/lib/voice-recording'

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
    const accounts = await app.withTenantContext(tenantId, () =>
      app.db
        .select({ personId: mailboxAccounts.personId, address: mailboxAccounts.address })
        .from(mailboxAccounts)
        .where(eq(mailboxAccounts.status, 'active')),
    )
    for (const account of accounts) {
      try {
        const { saved } = await syncPersonMailbox(tenantId, account.personId)
        if (saved > 0) console.log(`[mailbox] ${account.address}: ${saved} new`)
      } catch (error) {
        console.error(`[mailbox] ${account.address}:`, (error as Error).message)
      }
    }
    const started = await startRunsForNewInbound(tenantId)
    if (started > 0) console.log(`[runs] started ${started} inbound run(s)`)
  }
}

async function dutiesPass(): Promise<void> {
  for (const tenantId of await activeTenantIds()) {
    for (const duty of await dueDuties(tenantId)) {
      // First sighting of a recurring duty just anchors its schedule; it runs
      // from the next real occurrence rather than firing on scheduler boot. A
      // one-shot is pinned to an instant at creation and always fires.
      const anchoring = !duty.nextDueAt && duty.scheduleKind !== 'once'
      let next: Date | null
      try {
        next = nextOccurrence(duty)
      } catch (error) {
        // An unreadable schedule would otherwise stay permanently due and
        // re-fire every tick. Park it instead, leaving it visible and fixable.
        console.error(`[duty] ${duty.title}: ${(error as Error).message} — pausing`)
        await markDutyRun(tenantId, duty.id, null, false)
        continue
      }
      await markDutyRun(tenantId, duty.id, next, !anchoring)
      if (anchoring) continue
      const { outcome } = await executeAgentRun({
        tenantId,
        personId: duty.personId,
        trigger: { type: 'duty', dutyId: duty.id },
        input: { type: 'duty', dutyTitle: duty.title, instruction: duty.instruction },
      })
      console.log(`[duty] ${duty.title}: ${outcome.status}${next ? '' : ' (final run — duty retired)'}`)
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
            ...(run.trigger.type === 'assignment' ? { maxSteps: 60 } : {}),
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
type DeepWorkJob = { kind: 'assignment' | 'approval'; tenantId: string; id: string }

// Deep work — assignment runs and approval continuations — gets its own queue
// and worker so a multi-minute deliverable never blocks the heartbeat.
const deepWork = jobs.defineQueue<DeepWorkJob>('bunkhouse-deep-work')

const heartbeat = jobs.defineQueue<{ pass: HeartbeatPass }>('bunkhouse-heartbeat')
await heartbeat.upsertJobScheduler('mailbox', { every: 120_000 }, { name: 'tick', data: { pass: 'mailbox' } })
await heartbeat.upsertJobScheduler('duties', { every: 60_000 }, { name: 'tick', data: { pass: 'duties' } })
await heartbeat.upsertJobScheduler('approvals', { every: 30_000 }, { name: 'tick', data: { pass: 'approvals' } })
await heartbeat.upsertJobScheduler('assignments', { every: 30_000 }, { name: 'tick', data: { pass: 'assignments' } })
await heartbeat.upsertJobScheduler('calls', { every: 300_000 }, { name: 'tick', data: { pass: 'calls' } })
await heartbeat.upsertJobScheduler('waits', { every: 3_600_000 }, { name: 'tick', data: { pass: 'waits' } })
await heartbeat.upsertJobScheduler('reports', { every: 21_600_000 }, { name: 'tick', data: { pass: 'reports' } })
await heartbeat.upsertJobScheduler('workspace', { every: 86_400_000 }, { name: 'tick', data: { pass: 'workspace' } })
await heartbeat.upsertJobScheduler('gardener', { every: 86_400_000 }, { name: 'tick', data: { pass: 'gardener' } })
await heartbeat.upsertJobScheduler('trunks', { every: 300_000 }, { name: 'tick', data: { pass: 'trunks' } })
await heartbeat.upsertJobScheduler('journal', { every: 21_600_000 }, { name: 'tick', data: { pass: 'journal' } })
await heartbeat.upsertJobScheduler('reflection', { every: 43_200_000 }, { name: 'tick', data: { pass: 'reflection' } })

const worker = jobs.createWorker<{ pass: HeartbeatPass }>(
  'bunkhouse-heartbeat',
  async (job) => {
    if (job.data.pass === 'mailbox') await mailboxPass()
    else if (job.data.pass === 'duties') await dutiesPass()
    else if (job.data.pass === 'assignments') await assignmentsPass()
    else if (job.data.pass === 'calls') await callSweepPass()
    else if (job.data.pass === 'waits') await waitsPass()
    else if (job.data.pass === 'reports') await weeklyReportPass()
    else if (job.data.pass === 'workspace') await workspacePass()
    else if (job.data.pass === 'gardener') await gardenerPassAll()
    else if (job.data.pass === 'trunks') await trunkHealthPass()
    else if (job.data.pass === 'journal') await journalPass()
    else if (job.data.pass === 'reflection') await reflectionPass()
    else await approvalsPass()
  },
  { concurrency: 1 },
)

const deepWorker = jobs.createWorker<DeepWorkJob>(
  'bunkhouse-deep-work',
  async (job) => {
    if (job.data.kind === 'assignment') {
      await runAssignment(job.data.tenantId, job.data.id)
    } else {
      await executeDecidedApproval(job.data.tenantId, job.data.id)
    }
  },
  { concurrency: 2 },
)

await heartbeat.add('tick', { pass: 'mailbox' })
await heartbeat.add('tick', { pass: 'duties' })
await heartbeat.add('tick', { pass: 'approvals' })
await heartbeat.add('tick', { pass: 'assignments' })
console.log(
  'bunkhouse worker up — mailbox 2m, duties 1m, approvals 30s, assignments 30s, call sweep 5m, journal 6h, reflection 12h; deep-work queue ×2 (initial passes queued)',
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
