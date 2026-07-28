import { createJobs } from '@appkit/jobs'
import { CronExpressionParser } from 'cron-parser'
import { and, eq, inArray } from 'drizzle-orm'
import { schema as identity } from '@appkit/db'
import { db } from '../src/db/client'
import { approvals, mailboxAccounts, runEvents, runs } from '../src/db/schema'
import { syncPersonMailbox, sendReplyInThread } from '../src/lib/mailbox'
import { dueDuties, executeHandRun, markDutyRun, startRunsForNewInbound } from '../src/lib/hand-runs'

// The bunkhouse worker: mailbox sync → inbound runs, the duty scheduler, and
// approval resume — BullMQ on the shared Redis. One repeatable heartbeat job
// per concern; every pass is idempotent, so overlapping ticks are safe.

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
      const next = CronExpressionParser.parse(duty.schedule).next().toDate()
      await markDutyRun(tenantId, duty.id, next)
      // First sighting of a duty just anchors its schedule; it runs from the
      // next real occurrence rather than firing on scheduler boot.
      if (!duty.nextDueAt) continue
      const { outcome } = await executeHandRun({
        tenantId,
        personId: duty.personId,
        trigger: { type: 'duty', dutyId: duty.id },
        input: { type: 'duty', dutyTitle: duty.title, instruction: duty.instruction },
      })
      console.log(`[duty] ${duty.title}: ${outcome.status}`)
    }
  }
}

async function approvalsPass(): Promise<void> {
  for (const tenantId of await activeTenantIds()) {
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

const heartbeat = jobs.defineQueue<{ pass: 'mailbox' | 'duties' | 'approvals' }>('bunkhouse-heartbeat')
await heartbeat.upsertJobScheduler('mailbox', { every: 120_000 }, { name: 'tick', data: { pass: 'mailbox' } })
await heartbeat.upsertJobScheduler('duties', { every: 60_000 }, { name: 'tick', data: { pass: 'duties' } })
await heartbeat.upsertJobScheduler('approvals', { every: 30_000 }, { name: 'tick', data: { pass: 'approvals' } })

const worker = jobs.createWorker<{ pass: 'mailbox' | 'duties' | 'approvals' }>(
  'bunkhouse-heartbeat',
  async (job) => {
    if (job.data.pass === 'mailbox') await mailboxPass()
    else if (job.data.pass === 'duties') await dutiesPass()
    else await approvalsPass()
  },
  { concurrency: 3 },
)

console.log('bunkhouse worker up — mailbox 2m, duties 1m, approvals 30s')

async function shutdown(): Promise<void> {
  await worker.close()
  await jobs.closeJobConnections()
  await app.pool.end()
  await app.superPool.end()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
