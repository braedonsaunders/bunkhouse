import 'server-only'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  defineAbility,
  runHand,
  type Ability,
  type ActionCategory,
  type AutonomyLevel,
  type BoundProcedure,
  type RunInput,
  type RunOutcome,
} from '@bunkhouse/runtime'
import {
  autonomySettings,
  approvals,
  duties,
  mailMessages,
  mailThreads,
  memories,
  people,
  procedureRevisions,
  procedures,
  runEvents,
  runs,
  tokenSpend,
  type RunTrigger,
} from '../db/schema'
import { db } from '../db/client'
import { resolveHandAiConfig } from './ai'
import { sendReplyInThread } from './mailbox'

/** Crude but honest cost estimate until per-model price tables land. */
const USD_PER_INPUT_TOKEN = 3 / 1_000_000
const USD_PER_OUTPUT_TOKEN = 15 / 1_000_000

async function monthSpendUsd(tenantId: string, personId: string): Promise<number> {
  const app = db()
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)
  const [row] = await app.db
    .select({ total: sql<string>`coalesce(sum(${tokenSpend.costUsd}), 0)` })
    .from(tokenSpend)
    .where(and(eq(tokenSpend.personId, personId), gte(tokenSpend.createdAt, monthStart)))
  return Number(row?.total ?? 0)
}

async function boundProcedures(tenantId: string, person: typeof people.$inferSelect): Promise<BoundProcedure[]> {
  const app = db()
  const heads = await app.db.select().from(procedures).where(eq(procedures.status, 'active'))
  const applicable = heads.filter((p) => {
    const a = p.assignment
    if (a.everyone) return true
    if (person.rolePackSlug && a.rolePacks?.includes(person.rolePackSlug)) return true
    return a.personIds?.includes(person.id) ?? false
  })
  const out: BoundProcedure[] = []
  for (const head of applicable) {
    const [rev] = await app.db
      .select()
      .from(procedureRevisions)
      .where(and(eq(procedureRevisions.procedureId, head.id), eq(procedureRevisions.version, head.currentVersion)))
    if (rev) out.push({ id: head.id, slug: head.slug, title: head.title, version: rev.version, body: rev.body })
  }
  return out
}

/**
 * Execute one unit of work for a hand, end to end: run row, governed loop,
 * event/spend ledger, approval suspension, outcome. Runs inside the caller's
 * process (web action or worker) — all state is in the database.
 */
export async function executeHandRun(args: {
  tenantId: string
  personId: string
  trigger: RunTrigger
  input: RunInput
}): Promise<{ runId: string; outcome: RunOutcome }> {
  const app = db()
  return app.withTenant(args.tenantId, async () => {
    const [person] = await app.db.select().from(people).where(eq(people.id, args.personId))
    if (!person || person.kind !== 'hand') throw new Error('Run target is not a hand.')

    const [run] = await app.db
      .insert(runs)
      .values({ tenantId: args.tenantId, personId: person.id, trigger: args.trigger })
      .returning({ id: runs.id })
    const runId = run!.id
    let seq = 0
    const sink = {
      event: async (event: Record<string, unknown> & { kind: string }) => {
        const { kind, ...payload } = event
        await app.db.insert(runEvents).values({
          tenantId: args.tenantId,
          runId,
          seq: seq++,
          kind: kind as (typeof runEvents.$inferInsert)['kind'],
          payload,
        })
      },
      spend: async (usage: { provider: string; model: string; inputTokens: number; outputTokens: number }) => {
        const cost = usage.inputTokens * USD_PER_INPUT_TOKEN + usage.outputTokens * USD_PER_OUTPUT_TOKEN
        await app.db.insert(tokenSpend).values({
          tenantId: args.tenantId,
          personId: person.id,
          runId,
          provider: usage.provider,
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd: cost.toFixed(6),
        })
      },
    }

    const ai = await resolveHandAiConfig(args.tenantId, person.id)
    if (!ai) {
      await sink.event({ kind: 'error', message: 'No model assigned — set a provider and model on the profile.' })
      await app.db
        .update(runs)
        .set({ status: 'failed', finishedAt: new Date(), summary: 'No model assigned.' })
        .where(eq(runs.id, runId))
      return { runId, outcome: { status: 'failed', error: 'No model assigned.', usage: { inputTokens: 0, outputTokens: 0 } } }
    }

    const dialRows = await app.db
      .select()
      .from(autonomySettings)
      .where(eq(autonomySettings.personId, person.id))
    const dial = new Map(dialRows.map((r) => [r.category, r.level]))

    const directory = await app.db.select().from(people).where(eq(people.status, 'active'))
    const notes = await app.db
      .select()
      .from(memories)
      .where(and(eq(memories.status, 'active'), sql`(${memories.personId} = ${person.id} or ${memories.scope} = 'company')`))

    const abilities: Ability[] = [
      defineAbility({
        name: 'save_memory',
        description: 'Save a short note to your own memory so you remember it in future work.',
        category: null,
        inputSchema: z.object({ title: z.string(), body: z.string() }),
        execute: async ({ title, body }) => {
          const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'note'
          await app.db
            .insert(memories)
            .values({ tenantId: args.tenantId, scope: 'hand', personId: person.id, slug, title, body, sourceRunId: runId })
            .onConflictDoUpdate({
              target: [memories.tenantId, memories.scope, memories.personId, memories.slug],
              set: { title, body, status: 'active', updatedAt: new Date() },
            })
          return { saved: true }
        },
      }),
    ]
    if (args.trigger.type === 'email') {
      const threadId = args.trigger.threadId
      abilities.push(
        defineAbility({
          name: 'reply_to_thread',
          description: 'Send your reply on the email thread you are handling. The body is sent as-is from your mailbox.',
          category: 'external_email',
          inputSchema: z.object({ body: z.string() }),
          execute: async ({ body }) => {
            await sendReplyInThread({ tenantId: args.tenantId, threadId, text: body, runId })
            return { sent: true }
          },
        }),
      )
    }

    const outcome = await runHand({
      hand: {
        id: person.id,
        name: person.name,
        title: person.title,
        email: person.email,
        personality: person.personality ?? {
          bio: person.responsibilities ?? `I am the ${person.title}.`,
          tone: ['professional'],
          signoff: `Best,\n${person.name.split(' ')[0]}`,
        },
        ai,
        ...(person.responsibilities ? { responsibilities: person.responsibilities } : {}),
        proactivity: person.proactivity ?? 'duties',
      },
      company: {
        name: 'the company',
        directory: directory.map((p) => ({
          id: p.id,
          kind: p.kind,
          name: p.name,
          title: p.title,
          email: p.email,
          ...(p.responsibilities ? { responsibilities: p.responsibilities } : {}),
          ...(p.reportsToId ? { reportsToId: p.reportsToId } : {}),
        })),
      },
      procedures: await boundProcedures(args.tenantId, person),
      memories: notes.map((n) => ({ scope: n.scope, slug: n.slug, title: n.title, body: n.body })),
      abilities,
      input: args.input,
      autonomy: (category: ActionCategory): AutonomyLevel => dial.get(category) ?? 'approval',
      approvals: {
        request: async (input) => {
          const [row] = await app.db
            .insert(approvals)
            .values({
              tenantId: args.tenantId,
              runId,
              personId: person.id,
              category: input.category,
              payload: { description: input.description, action: input.action },
            })
            .returning({ id: approvals.id })
          return { approvalId: row!.id }
        },
      },
      budget: {
        remainingUsd: async () => (person.salary?.monthlyUsd ?? 50) - (await monthSpendUsd(args.tenantId, person.id)),
        overagePolicy: person.salary?.overagePolicy ?? 'ask',
      },
      sink,
    })

    const status =
      outcome.status === 'completed'
        ? ('completed' as const)
        : outcome.status === 'waiting_approval'
          ? ('waiting_approval' as const)
          : ('failed' as const)
    await app.db
      .update(runs)
      .set({
        status,
        finishedAt: status === 'waiting_approval' ? null : new Date(),
        summary:
          outcome.status === 'completed'
            ? outcome.summary.slice(0, 500)
            : outcome.status === 'waiting_approval'
              ? 'Waiting on an approval.'
              : outcome.status === 'budget_paused'
                ? 'Paused: salary budget exhausted.'
                : outcome.error.slice(0, 500),
      })
      .where(eq(runs.id, runId))
    return { runId, outcome }
  })
}

/** Render an email thread into the run instruction's conversation block. */
export async function threadConversation(tenantId: string, threadId: string): Promise<{ subject: string; conversation: string }> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [thread] = await app.db.select().from(mailThreads).where(eq(mailThreads.id, threadId))
    if (!thread) throw new Error('Thread not found')
    const messages = await app.db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.threadId, threadId))
      .orderBy(desc(mailMessages.sentAt))
    const conversation = messages
      .slice(0, 10)
      .reverse()
      .map((m) => `From ${m.from.name || m.from.address} (${m.direction}) at ${m.sentAt.toISOString()}:\n${m.bodyText}`)
      .join('\n\n---\n\n')
    return { subject: thread.subject, conversation }
  })
}

/** Find inbound messages that never got a run and start one per thread. */
export async function startRunsForNewInbound(tenantId: string): Promise<number> {
  const app = db()
  const pending = await app.withTenantContext(tenantId, () =>
    app.db
      .select({
        messageId: mailMessages.id,
        threadId: mailMessages.threadId,
        personId: sql<string>`(select person_id from mailbox_accounts ma join mail_threads mt on mt.mailbox_id = ma.id where mt.id = ${mailMessages.threadId})`,
      })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.direction, 'inbound'),
          sql`not exists (select 1 from runs r where r.trigger->>'messageId' = ${mailMessages.id}::text)`,
        ),
      )
      .limit(20),
  )
  let started = 0
  for (const item of pending) {
    if (!item.personId) continue
    const { subject, conversation } = await threadConversation(tenantId, item.threadId)
    await executeHandRun({
      tenantId,
      personId: item.personId,
      trigger: { type: 'email', threadId: item.threadId, messageId: item.messageId },
      input: { type: 'email', threadSubject: subject, conversation },
    })
    started += 1
  }
  return started
}

/** Due duties → runs; nextDueAt advanced by the caller-provided cron parser. */
export async function dueDuties(tenantId: string): Promise<(typeof duties.$inferSelect)[]> {
  const app = db()
  return app.withTenantContext(tenantId, () =>
    app.db
      .select()
      .from(duties)
      .where(and(eq(duties.enabled, 'on'), sql`(${duties.nextDueAt} is null or ${duties.nextDueAt} <= now())`)),
  )
}

export async function markDutyRun(tenantId: string, dutyId: string, nextDueAt: Date): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db.update(duties).set({ lastRunAt: new Date(), nextDueAt }).where(eq(duties.id, dutyId))
  })
}
