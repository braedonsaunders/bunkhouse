import { createJobs } from '@appkit/jobs'
import { and, eq, sql } from 'drizzle-orm'
import { schema as identity } from '@appkit/db'
import { db } from '../src/db/client'
import { approvals, mailboxAccounts, mailMessages, people, runEvents, runs } from '../src/db/schema'
import { syncPersonMailbox, sendReplyInThread } from '../src/lib/mailbox'
import { dueDuties, executeAgentRun, markDutyRun, startRunsForNewInbound } from '../src/lib/agent-runs'
import { nextOccurrence } from '../src/lib/duties'
import { journalPass as journalTenant, reflectionPass as reflectTenant } from '../src/lib/consolidation'

// The bunkhouse worker: mailbox sync → inbound runs, the duty scheduler,
// approval resume, and the Logbook consolidation jobs — BullMQ on the shared
// Redis. One repeatable heartbeat job per concern; every pass is idempotent,
// so overlapping ticks are safe.

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
        if (decision === 'rejected') {
          await app.db
            .update(runs)
            .set({ status: 'completed', finishedAt: new Date(), summary: 'Stopped: the requested action was declined by email.' })
            .where(and(eq(runs.id, approval.runId), eq(runs.status, 'waiting_approval')))
        }
        console.log(`[approval] ${tag} ${decision} by email from ${sender}`)
        break
      }
    }
  })
}

async function approvalsPass(): Promise<void> {
  for (const tenantId of await activeTenantIds()) {
    await applyEmailedDecisions(tenantId)
    await app.withTenant(tenantId, async () => {
      const ready = await app.db
        .select()
        .from(approvals)
        .innerJoin(runs, eq(runs.id, approvals.runId))
        .where(and(eq(approvals.status, 'approved'), eq(runs.status, 'waiting_approval')))
      for (const row of ready) {
        const approval = row.approvals
        const run = row.runs
        const action = approval.payload.action as { toolName?: string; input?: Record<string, unknown> }
        let summary: string
        if (action.toolName === 'reply_to_thread' && run.trigger.type === 'email') {
          const body = String((action.input as { input?: { body?: string } })?.input?.body ?? (action.input as { body?: string })?.body ?? '')
          await sendReplyInThread({ tenantId, threadId: run.trigger.threadId, text: body, runId: run.id })
          summary = 'Approved reply sent.'
        } else {
          summary = `Approved action "${action.toolName ?? 'unknown'}" recorded; no automatic executor for it yet.`
        }
        const [last] = await app.db
          .select({ seq: runEvents.seq })
          .from(runEvents)
          .where(eq(runEvents.runId, run.id))
          .orderBy(eq(runEvents.seq, runEvents.seq))
        await app.db.insert(runEvents).values({
          tenantId,
          runId: run.id,
          seq: (last?.seq ?? 0) + 1000,
          kind: 'tool_result',
          payload: { toolName: action.toolName ?? 'unknown', output: { approved: true, summary } },
        })
        await app.db
          .update(runs)
          .set({ status: 'completed', finishedAt: new Date(), summary })
          .where(eq(runs.id, run.id))
        console.log(`[approval] run ${run.id}: ${summary}`)
      }
    })
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

type HeartbeatPass = 'mailbox' | 'duties' | 'approvals' | 'journal' | 'reflection'

const heartbeat = jobs.defineQueue<{ pass: HeartbeatPass }>('bunkhouse-heartbeat')
await heartbeat.upsertJobScheduler('mailbox', { every: 120_000 }, { name: 'tick', data: { pass: 'mailbox' } })
await heartbeat.upsertJobScheduler('duties', { every: 60_000 }, { name: 'tick', data: { pass: 'duties' } })
await heartbeat.upsertJobScheduler('approvals', { every: 30_000 }, { name: 'tick', data: { pass: 'approvals' } })
await heartbeat.upsertJobScheduler('journal', { every: 21_600_000 }, { name: 'tick', data: { pass: 'journal' } })
await heartbeat.upsertJobScheduler('reflection', { every: 43_200_000 }, { name: 'tick', data: { pass: 'reflection' } })

const worker = jobs.createWorker<{ pass: HeartbeatPass }>(
  'bunkhouse-heartbeat',
  async (job) => {
    if (job.data.pass === 'mailbox') await mailboxPass()
    else if (job.data.pass === 'duties') await dutiesPass()
    else if (job.data.pass === 'journal') await journalPass()
    else if (job.data.pass === 'reflection') await reflectionPass()
    else await approvalsPass()
  },
  { concurrency: 1 },
)

await heartbeat.add('tick', { pass: 'mailbox' })
await heartbeat.add('tick', { pass: 'duties' })
await heartbeat.add('tick', { pass: 'approvals' })
console.log('bunkhouse worker up — mailbox 2m, duties 1m, approvals 30s, journal 6h, reflection 12h (initial passes queued)')

async function shutdown(): Promise<void> {
  await worker.close()
  await jobs.closeJobConnections()
  await app.pool.end()
  await app.superPool.end()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
