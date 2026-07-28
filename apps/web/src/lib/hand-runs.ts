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
import { resolvePrice } from './pricing'
import { sendNewMail, sendReplyInThread } from './mailbox'
import { createNote, pinnedNotes, retrieveNotes, supersedeNote } from './memory'



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

/** Active procedure revisions bound to a person — shared with the voice agent. */
export async function boundProcedures(tenantId: string, person: typeof people.$inferSelect): Promise<BoundProcedure[]> {
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
        const price = await resolvePrice(args.tenantId, usage.model)
        const cost =
          (usage.inputTokens * price.inputUsdPerMtok + usage.outputTokens * price.outputUsdPerMtok) / 1_000_000
        await app.db.insert(tokenSpend).values({
          tenantId: args.tenantId,
          personId: person.id,
          runId,
          provider: usage.provider,
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd: cost.toFixed(6),
          inputUsdPerMtok: price.inputUsdPerMtok.toFixed(4),
          outputUsdPerMtok: price.outputUsdPerMtok.toFixed(4),
          priceSource: price.source,
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
    // The Logbook: pinned tier always in prompt; the rest scored per task.
    const retrievalQuery =
      args.input.type === 'email'
        ? `${args.input.threadSubject} ${args.input.conversation.slice(-400)}`
        : args.input.type === 'duty'
          ? `${args.input.dutyTitle} ${args.input.instruction}`
          : args.input.type === 'chat'
            ? args.input.message
            : args.input.type === 'delegation'
              ? args.input.instruction
              : args.input.instruction
    const pinned = await pinnedNotes({ tenantId: args.tenantId, personId: person.id })
    const retrieved = await retrieveNotes({ tenantId: args.tenantId, personId: person.id, query: retrievalQuery })
    const notes = [...pinned, ...retrieved.filter((r) => !pinned.some((p) => p.id === r.id))]

    const abilities: Ability[] = [
      defineAbility({
        name: 'save_memory',
        description:
          'Save a note to your logbook. kind: fact (currently true), episode (what happened), procedure (how to do something), reflection (a conclusion — cite evidence with [[slug]] links). If a live note with the same title exists, yours supersedes it (the old one is kept in history). Use [[wikilinks]] to connect notes.',
        category: null,
        inputSchema: z.object({
          title: z.string(),
          body: z.string(),
          kind: z.enum(['fact', 'episode', 'procedure', 'reflection']).default('fact'),
          importance: z.number().min(1).max(5).default(3),
        }),
        execute: async ({ title, body, kind, importance }) => {
          const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'note'
          const [existing] = await app.db
            .select()
            .from(memories)
            .where(
              and(
                eq(memories.scope, 'hand'),
                eq(memories.personId, person.id),
                eq(memories.slug, slug),
                sql`${memories.validUntil} is null`,
              ),
            )
          if (existing) {
            await supersedeNote({ tenantId: args.tenantId, oldNoteId: existing.id, title, body, author: 'hand', sourceRunId: runId })
            return { saved: true, superseded: existing.slug }
          }
          await createNote({
            tenantId: args.tenantId,
            scope: 'hand',
            personId: person.id,
            kind,
            title,
            body,
            author: 'hand',
            importance,
            sourceRunId: runId,
          })
          return { saved: true }
        },
      }),
      defineAbility({
        name: 'search_memory',
        description: 'Search your logbook and company knowledge for notes relevant to a query. Returns the best matches with their [[slug]] handles.',
        category: null,
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => {
          const found = await retrieveNotes({ tenantId: args.tenantId, personId: person.id, query, limit: 6 })
          return {
            notes: found.map((n) => ({ slug: n.slug, kind: n.kind, title: n.title, body: n.body })),
          }
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
    if (outcome.status === 'waiting_approval' && person.reportsToId) {
      const [manager] = await app.db.select().from(people).where(eq(people.id, person.reportsToId))
      const [approval] = await app.db.select().from(approvals).where(eq(approvals.id, outcome.approvalId))
      if (manager && approval) {
        try {
          await sendNewMail({
            tenantId: args.tenantId,
            personId: person.id,
            to: [{ name: manager.name, address: manager.email }],
            subject: `[BH#${approval.id.slice(0, 8)}] Approval needed: ${approval.category.replace('_', ' ')}`,
            text: `Hi ${manager.name.split(' ')[0]},\n\nI need your sign-off before I act:\n\n${approval.payload.description}\n\nReply to this email with "approve" or "decline" (a short note after the word is kept for the record). You can also decide it in Bunkhouse under Approvals.\n\n${person.personality?.signoff ?? person.name}`,
            runId,
          })
          await sink.event({ kind: 'message', text: `Approval request emailed to ${manager.name} <${manager.email}>.` })
        } catch (error) {
          await sink.event({
            kind: 'message',
            text: `Could not email the approval request (${error instanceof Error ? error.message : String(error)}); it is waiting in the Approvals queue.`,
          })
        }
      }
    }

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

type SenderTrust = 'staff' | 'known' | 'unknown'

/** Classify a sender against the directory and the mail ledger. */
async function classifySender(tenantId: string, address: string, before: Date): Promise<SenderTrust> {
  const app = db()
  const lower = address.toLowerCase()
  const staff = await app.db
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.status, 'active'), sql`lower(${people.email}) = ${lower}`))
    .limit(1)
  if (staff.length > 0) return 'staff'
  const prior = await app.db
    .select({ id: mailMessages.id })
    .from(mailMessages)
    .where(and(sql`lower(${mailMessages.from}->>'address') = ${lower}`, sql`${mailMessages.sentAt} < ${before}`))
    .limit(1)
  return prior.length > 0 ? 'known' : 'unknown'
}

function senderPermitted(policy: 'staff_only' | 'known_contacts' | 'anyone', trust: SenderTrust): boolean {
  if (policy === 'anyone') return true
  if (policy === 'known_contacts') return trust === 'staff' || trust === 'known'
  return trust === 'staff'
}

/**
 * Inbound messages that never got a run: gate each by the hand's inbound
 * policy, then start a run — or record an auditable declined run so the
 * message is never silently reprocessed.
 */
export async function startRunsForNewInbound(tenantId: string): Promise<number> {
  const app = db()
  const pending = await app.withTenantContext(tenantId, () =>
    app.db
      .select({
        messageId: mailMessages.id,
        threadId: mailMessages.threadId,
        sender: sql<string>`${mailMessages.from}->>'address'`,
        sentAt: mailMessages.sentAt,
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
    const decision = await app.withTenantContext(tenantId, async () => {
      const [hand] = await app.db.select().from(people).where(eq(people.id, item.personId))
      if (!hand) return { allowed: false as const, policy: 'staff_only' as const, trust: 'unknown' as const }
      const policy = hand.inboundPolicy ?? 'staff_only'
      const trust = await classifySender(tenantId, item.sender ?? '', item.sentAt)
      return { allowed: senderPermitted(policy, trust), policy, trust }
    })
    if (!decision.allowed) {
      await app.withTenant(tenantId, async () => {
        const summary = `Declined: ${item.sender ?? 'unknown sender'} (${decision.trust}) is not permitted by this hand's inbound policy (${decision.policy.replace('_', ' ')}).`
        const [run] = await app.db
          .insert(runs)
          .values({
            tenantId,
            personId: item.personId,
            status: 'completed',
            trigger: { type: 'email', threadId: item.threadId, messageId: item.messageId },
            summary,
            finishedAt: new Date(),
          })
          .returning({ id: runs.id })
        await app.db.insert(runEvents).values({
          tenantId,
          runId: run!.id,
          seq: 0,
          kind: 'message',
          payload: { text: summary },
        })
      })
      continue
    }
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
