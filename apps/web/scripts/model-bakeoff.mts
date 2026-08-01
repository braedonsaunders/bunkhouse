// Model bake-off: run one identical inbound email through an agent on each of
// several models and record what each one drafted, spent, and took.
import { eq, and, gt } from 'drizzle-orm'
import { schema as identity } from '@appkit/db'
import { db } from '../src/db/client'
import { approvals, mailboxAccounts, mailMessages, mailThreads, people, runs, tokenSpend } from '../src/db/schema'
import { startRunsForNewInbound } from '../src/lib/agent-runs'

const MODELS = process.argv.slice(3)
const AGENT_EMAIL = process.argv[2]
if (!AGENT_EMAIL || MODELS.length === 0) throw new Error('usage: _bakeoff.mts <agent-email> <model> [model...]')

const SCENARIO = {
  subject: 'Leaking pump - refund request (invoice RS-44192)',
  from: { address: 'ron@vandersluisfarms.ca', name: 'Ron Vandersluis' },
  body: `Bill,

I bought a Grundfos circulator pump from you on May 12th, invoice #RS-44192, $612 plus tax. It started leaking at the seal last week.

I know your return window is 30 days and I'm outside it, and honestly I threw out the receipt — I only have the invoice number above from my credit card statement.

I'd like a full refund or a free replacement. I've been a customer for eleven years and I'd hate for this to be the thing that changes that. Can you get this sorted today?

Ron Vandersluis
Vandersluis Farms`,
}

const app = db()
const [tenant] = await app.withSuperAdmin((s) =>
  s.select({ id: identity.tenants.id }).from(identity.tenants).where(eq(identity.tenants.status, 'active')).limit(1),
)
const tenantId = tenant!.id

const [agent] = await app.withTenantContext(tenantId, () =>
  app.db.select().from(people).where(eq(people.email, AGENT_EMAIL)),
)
if (!agent) throw new Error(`No agent ${AGENT_EMAIL}`)
const [mailbox] = await app.withTenantContext(tenantId, () =>
  app.db.select().from(mailboxAccounts).where(eq(mailboxAccounts.personId, agent.id)),
)
if (!mailbox) throw new Error('Agent has no mailbox')

const original = agent.modelConfig
const results: Record<string, unknown>[] = []

for (const model of MODELS) {
  const label = model.replace(/[^a-z0-9]/gi, '-')
  await app.withTenant(tenantId, async () => {
    await app.db
      .update(people)
      .set({ modelConfig: { provider: 'openrouter', model } })
      .where(eq(people.id, agent.id))
  })

  // A fresh thread per model so every run starts from the same clean state.
  const startedAt = new Date()
  await app.withTenant(tenantId, async () => {
    const [thread] = await app.db
      .insert(mailThreads)
      .values({
        tenantId,
        mailboxId: mailbox.id,
        subject: `${SCENARIO.subject} [${label}]`,
        externalThreadKey: `bakeoff-${label}`,
        participants: [SCENARIO.from, { address: agent.email, name: agent.name }],
        lastMessageAt: startedAt,
      })
      .returning()
    await app.db.insert(mailMessages).values({
      tenantId,
      threadId: thread!.id,
      direction: 'inbound',
      from: SCENARIO.from,
      to: [{ address: agent.email, name: agent.name }],
      subject: `${SCENARIO.subject} [${label}]`,
      bodyText: SCENARIO.body,
      externalMessageId: `bakeoff-${label}@test.local`,
      sentAt: startedAt,
    })
  })

  let error: string | null = null
  try {
    await startRunsForNewInbound(tenantId)
  } catch (e) {
    error = (e as Error).message
  }
  const finishedAt = new Date()

  const [run] = await app.withTenantContext(tenantId, () =>
    app.db
      .select()
      .from(runs)
      .where(and(eq(runs.personId, agent.id), gt(runs.createdAt, startedAt)))
      .limit(1),
  )
  const spend = run
    ? await app.withTenantContext(tenantId, () =>
        app.db.select().from(tokenSpend).where(eq(tokenSpend.runId, run.id)),
      )
    : []
  const queued = run
    ? await app.withTenantContext(tenantId, () =>
        app.db.select().from(approvals).where(eq(approvals.runId, run.id)),
      )
    : []

  results.push({
    model,
    seconds: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
    runStatus: run?.status ?? 'no-run',
    error: error ?? null,
    summary: run?.summary ?? null,
    inputTokens: spend.reduce((n, s) => n + Number(s.inputTokens), 0),
    outputTokens: spend.reduce((n, s) => n + Number(s.outputTokens), 0),
    costUsd: spend.reduce((n, s) => n + Number(s.costUsd), 0),
    draft: queued.map((a) => (a.payload as { action?: { input?: { body?: string } } }).action?.input?.body ?? null),
  })
  console.log(JSON.stringify(results.at(-1)))
}

await app.withTenant(tenantId, async () => {
  await app.db.update(people).set({ modelConfig: original }).where(eq(people.id, agent.id))
})
console.log('---RESULTS---')
console.log(JSON.stringify(results, null, 2))
await app.pool.end()
await app.superPool.end()
