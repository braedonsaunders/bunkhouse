import 'server-only'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { ModelMessage } from 'ai'
import {
  defineAbility,
  runAgent,
  type Ability,
  type ActionCategory,
  type AutonomyLevel,
  type BoundProcedure,
  type GovernanceState,
  type RunInput,
  type RunInputImage,
  type RunOutcome,
} from '@bunkhouse/runtime'
import {
  autonomySettings,
  approvals,
  duties,
  mailMessages,
  mailThreads,
  people,
  procedureRevisions,
  procedures,
  runEvents,
  runs,
  tokenSpend,
  type RunTrigger,
} from '../db/schema'
import { db } from '../db/client'
import { resolveAgentAiConfig } from './ai'
import { companyPromptProfile, getCompanyIdentity } from './company-identity'
import { getMailSignature } from './mail-signature'
import { assembleAbilities } from './agent-abilities'
import { resolvePrice } from './pricing'
import { sendNewMail, sendReplyInThread } from './mailbox'
import { pinnedNotes, retrieveNotes } from './memory'
import { describeToolCall } from './call-activity'
import { isWithinWorkingHours } from './working-hours'
import { getFileBytes, getFileRecord } from './files'
import { closeBrowserSession } from './browser-use'



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
 * The thread-bound reply ability: only email-triggered runs carry it, and the
 * approval executor rebuilds it to carry out an approved reply.
 */
export function replyToThreadAbility(args: { tenantId: string; threadId: string; runId: string }): Ability {
  const { tenantId, threadId, runId } = args
  return defineAbility({
    name: 'reply_to_thread',
    description:
      'Send your reply on the email thread you are handling. The body is sent as-is from your mailbox. Attach files you produced by id with attachFileIds.',
    category: 'external_email',
    inputSchema: z.object({
      body: z.string(),
      attachFileIds: z.array(z.string()).optional().describe('File ids of documents to attach.'),
    }),
    execute: async ({ body, attachFileIds }) => {
      await sendReplyInThread({
        tenantId,
        threadId,
        text: body,
        runId,
        ...(attachFileIds?.length ? { attachFileIds } : {}),
      })
      return { sent: true, ...(attachFileIds?.length ? { attachedFiles: attachFileIds.length } : {}) }
    },
  })
}

/**
 * Execute one unit of work for an agent, end to end: run row, governed loop,
 * event/spend ledger, approval suspension, outcome. Runs inside the caller's
 * process (web action or worker) — all state is in the database.
 *
 * With `resumeRunId`, no new run row is created: the suspended run's stored
 * transcript becomes the prior context, the event sequence continues, and the
 * input (normally an approval decision) is appended as the next turn.
 */
export async function executeAgentRun(args: {
  tenantId: string
  personId: string
  trigger: RunTrigger
  input: RunInput
  resumeRunId?: string
  maxSteps?: number
  counterparty?: { name?: string; address?: string }
}): Promise<{ runId: string; outcome: RunOutcome }> {
  const app = db()
  return app.withTenant(args.tenantId, async () => {
    const [person] = await app.db.select().from(people).where(eq(people.id, args.personId))
    if (!person || person.kind !== 'agent') throw new Error('Run target is not an agent.')

    let runId: string
    let seq = 0
    let priorMessages: unknown[] = []
    if (args.resumeRunId) {
      const [existing] = await app.db.select().from(runs).where(eq(runs.id, args.resumeRunId))
      if (!existing || existing.personId !== person.id) throw new Error('Run to resume not found.')
      runId = existing.id
      priorMessages = existing.transcript ?? []
      const [last] = await app.db
        .select({ seq: sql<number>`coalesce(max(${runEvents.seq}), -1)` })
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
      seq = (last?.seq ?? -1) + 1
      await app.db
        .update(runs)
        .set({ status: 'running', finishedAt: null, waiting: null })
        .where(eq(runs.id, runId))
    } else {
      const [run] = await app.db
        .insert(runs)
        .values({ tenantId: args.tenantId, personId: person.id, trigger: args.trigger })
        .returning({ id: runs.id })
      runId = run!.id
    }
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

    const ai = await resolveAgentAiConfig(args.tenantId, person.id)
    if (!ai) {
      await sink.event({ kind: 'error', message: 'No model assigned — set a provider and model on the profile.' })
      await app.db
        .update(runs)
        .set({ status: 'failed', finishedAt: new Date(), summary: 'No model assigned.' })
        .where(eq(runs.id, runId))
      return {
        runId,
        outcome: {
          status: 'failed',
          error: 'No model assigned.',
          usage: { inputTokens: 0, outputTokens: 0 },
          messages: [],
        },
      }
    }

    const dialRows = await app.db
      .select()
      .from(autonomySettings)
      .where(eq(autonomySettings.personId, person.id))
    const dial = new Map(dialRows.map((r) => [r.category, r.level]))

    const directory = await app.db.select().from(people).where(eq(people.status, 'active'))
    const identity = await getCompanyIdentity(args.tenantId)
    const signature = await getMailSignature(args.tenantId)
    const signatureAppended = signature.enabled && signature.compiledHtml.trim().length > 0
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
              : args.input.type === 'assignment'
                ? `${args.input.title} ${args.input.spec.slice(0, 400)}`
                : args.input.type === 'approval_decision'
                  ? args.input.description
                  : args.input.type === 'reply_received'
                    ? args.input.question
                    : args.input.instruction
    const pinned = await pinnedNotes({ tenantId: args.tenantId, personId: person.id })
    const retrieved = await retrieveNotes({ tenantId: args.tenantId, personId: person.id, query: retrievalQuery })
    const notes = [...pinned, ...retrieved.filter((r) => !pinned.some((p) => p.id === r.id))]

    // The shared capability set — the same abilities voice calls carry, plus
    // ask_and_wait: async runs can genuinely pause on a person's answer.
    const waitState: GovernanceState = { pendingApprovalId: null, pendingWait: null }
    const assembled = await assembleAbilities({
      tenantId: args.tenantId,
      person,
      runId,
      assignmentSource:
        args.trigger.type === 'email' ? { kind: 'mail', threadId: args.trigger.threadId } : { kind: 'manual' },
      ...(args.counterparty ? { counterparty: args.counterparty } : {}),
      waitState,
    })
    for (const failure of assembled.integrationFailures) {
      await sink.event({ kind: 'message', text: `Integration unavailable — ${failure}` })
    }
    const abilities: Ability[] = [...assembled.abilities]
    if (args.trigger.type === 'email') {
      abilities.push(replyToThreadAbility({ tenantId: args.tenantId, threadId: args.trigger.threadId, runId }))
    }

    const outcome = await runAgent({
      ...(priorMessages.length ? { priorMessages: priorMessages as ModelMessage[] } : {}),
      ...(args.maxSteps ? { maxSteps: args.maxSteps } : {}),
      state: waitState,
      describeAction: describeToolCall,
      agent: {
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
        ...(person.reportsToId ? { reportsToId: person.reportsToId } : {}),
        proactivity: person.proactivity ?? 'duties',
        ...(signatureAppended ? { signatureAppended: true } : {}),
      },
      company: {
        ...companyPromptProfile(identity),
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
    }).finally(async () => {
      await assembled.close()
      // A browser left open by the model is closed with the run, not leaked.
      await closeBrowserSession(runId)
    })

    const status =
      outcome.status === 'completed'
        ? ('completed' as const)
        : outcome.status === 'waiting_approval'
          ? ('waiting_approval' as const)
          : outcome.status === 'waiting_reply'
            ? ('waiting_reply' as const)
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

    const parked = status === 'waiting_approval' || status === 'waiting_reply'
    await app.db
      .update(runs)
      .set({
        status,
        finishedAt: parked ? null : new Date(),
        // The transcript exists to resume a parked run; a finished run keeps
        // its ledger in run_events, not a copy of the model conversation.
        transcript: parked ? (outcome.messages as unknown[]) : null,
        waiting:
          outcome.status === 'waiting_reply'
            ? { ...outcome.wait, askedAt: new Date().toISOString() }
            : null,
        summary:
          outcome.status === 'completed'
            ? outcome.summary.slice(0, 500)
            : outcome.status === 'waiting_approval'
              ? 'Waiting on an approval.'
              : outcome.status === 'waiting_reply'
                ? `Waiting to hear back from ${outcome.wait.to}.`
                : outcome.status === 'budget_paused'
                  ? 'Paused: salary budget exhausted.'
                  : outcome.error.slice(0, 500),
      })
      .where(eq(runs.id, runId))
    return { runId, outcome }
  })
}

/** How many thread images ride into the model, and how big each may be. */
const MAX_RUN_IMAGES = 4
const MAX_RUN_IMAGE_BYTES = 4 * 1024 * 1024

/** Render an email thread into the run instruction's conversation block. */
export async function threadConversation(
  tenantId: string,
  threadId: string,
): Promise<{ subject: string; conversation: string; images: RunInputImage[] }> {
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
      .map((m) => {
        const attachments = m.attachments.length
          ? `\n[Attachments: ${m.attachments.map((a) => `${a.filename} (file id ${a.fileId})`).join(', ')} — open them with read_file]`
          : ''
        return `From ${m.from.name || m.from.address} (${m.direction}) at ${m.sentAt.toISOString()}:\n${m.bodyText}${attachments}`
      })
      .join('\n\n---\n\n')

    // Recent inbound image attachments become part of what the agent sees —
    // newest first, bounded so one photo-heavy thread cannot flood the context.
    const images: RunInputImage[] = []
    for (const message of messages) {
      if (message.direction !== 'inbound') continue
      for (const attachment of message.attachments) {
        if (images.length >= MAX_RUN_IMAGES) break
        if (!attachment.contentType.startsWith('image/')) continue
        if (attachment.size > MAX_RUN_IMAGE_BYTES) continue
        const record = await getFileRecord(tenantId, attachment.fileId)
        if (!record) continue
        const bytes = await getFileBytes(record)
        images.push({
          filename: attachment.filename,
          mediaType: attachment.contentType,
          dataBase64: Buffer.from(bytes).toString('base64'),
        })
      }
      if (images.length >= MAX_RUN_IMAGES) break
    }
    return { subject: thread.subject, conversation, images }
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
 * Inbound messages that never got a run: gate each by the agent's inbound
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
        senderName: sql<string | null>`${mailMessages.from}->>'name'`,
        bodyText: mailMessages.bodyText,
        sentAt: mailMessages.sentAt,
        personId: sql<string>`(select person_id from mailbox_accounts ma join mail_threads mt on mt.mailbox_id = ma.id where mt.id = ${mailMessages.threadId})`,
      })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.direction, 'inbound'),
          sql`not exists (select 1 from runs r where r.trigger->>'messageId' = ${mailMessages.id}::text)`,
          sql`not exists (select 1 from runs r where ${mailMessages.id} = any(r.consumed_message_ids))`,
        ),
      )
      .limit(20),
  )
  let started = 0
  for (const item of pending) {
    if (!item.personId) continue

    // Working hours: outside the agent's window, inbound work simply waits —
    // the message stays pending and is picked up when the window opens.
    const [agentHours] = await app.withTenantContext(tenantId, () =>
      app.db.select({ workingHours: people.workingHours }).from(people).where(eq(people.id, item.personId)),
    )
    if (!isWithinWorkingHours(agentHours?.workingHours)) continue

    // A run parked on this thread gets the answer it was waiting for — the
    // message resumes that run instead of starting a fresh one.
    const [waitingRun] = await app.withTenantContext(tenantId, () =>
      app.db
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.personId, item.personId),
            eq(runs.status, 'waiting_reply'),
            sql`${runs.waiting}->>'threadId' = ${item.threadId}::text`,
          ),
        )
        .limit(1),
    )
    if (waitingRun?.waiting) {
      await app.withTenant(tenantId, async () => {
        await app.db
          .update(runs)
          .set({ consumedMessageIds: sql`array_append(${runs.consumedMessageIds}, ${item.messageId}::uuid)` })
          .where(eq(runs.id, waitingRun.id))
      })
      const resumed = await executeAgentRun({
        tenantId,
        personId: item.personId,
        trigger: waitingRun.trigger,
        resumeRunId: waitingRun.id,
        ...(waitingRun.trigger.type === 'assignment' ? { maxSteps: 60 } : {}),
        input: {
          type: 'reply_received',
          question: waitingRun.waiting.question,
          askedOf: waitingRun.waiting.to,
          reply: {
            ...(item.senderName ? { fromName: item.senderName } : {}),
            fromAddress: item.sender ?? waitingRun.waiting.to,
            text: item.bodyText,
          },
        },
      })
      if (waitingRun.trigger.type === 'assignment') {
        const { finalizeAssignmentRun } = await import('./assignments')
        await finalizeAssignmentRun(tenantId, waitingRun.trigger.assignmentId, resumed.runId, resumed.outcome)
      }
      started += 1
      continue
    }
    const decision = await app.withTenantContext(tenantId, async () => {
      const [agent] = await app.db.select().from(people).where(eq(people.id, item.personId))
      if (!agent) return { allowed: false as const, policy: 'staff_only' as const, trust: 'unknown' as const }
      const policy = agent.inboundPolicy ?? 'staff_only'
      const trust = await classifySender(tenantId, item.sender ?? '', item.sentAt)
      return { allowed: senderPermitted(policy, trust), policy, trust }
    })
    if (!decision.allowed) {
      await app.withTenant(tenantId, async () => {
        const summary = `Declined: ${item.sender ?? 'unknown sender'} (${decision.trust}) is not permitted by this agent's inbound policy (${decision.policy.replace('_', ' ')}).`
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
    const { subject, conversation, images } = await threadConversation(tenantId, item.threadId)
    await executeAgentRun({
      tenantId,
      personId: item.personId,
      trigger: { type: 'email', threadId: item.threadId, messageId: item.messageId },
      input: { type: 'email', threadSubject: subject, conversation, ...(images.length ? { images } : {}) },
      // The sender is who work committed on this thread defaults to.
      ...(item.sender ? { counterparty: { address: item.sender } } : {}),
    })
    started += 1
  }
  return started
}

/** Due duties → runs; the kind-aware next occurrence comes from lib/duties. */
export async function dueDuties(tenantId: string): Promise<(typeof duties.$inferSelect)[]> {
  const app = db()
  return app.withTenantContext(tenantId, () =>
    app.db
      .select()
      .from(duties)
      .where(and(eq(duties.enabled, 'on'), sql`(${duties.nextDueAt} is null or ${duties.nextDueAt} <= now())`)),
  )
}

/**
 * Record a duty's fire and arm the next one. A null `nextDueAt` means the duty
 * is spent — a one-shot that has now happened, or a recurrence past its end
 * date or run budget — so it retires itself rather than staying permanently
 * due. `ran` is false for the first-sighting pass that only anchors a
 * schedule, which must not consume the run budget.
 */
export async function markDutyRun(
  tenantId: string,
  dutyId: string,
  nextDueAt: Date | null,
  ran = true,
): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .update(duties)
      .set({
        nextDueAt,
        updatedAt: new Date(),
        ...(ran ? { lastRunAt: new Date(), runCount: sql`${duties.runCount} + 1` } : {}),
        ...(nextDueAt === null ? { enabled: 'off' as const } : {}),
      })
      .where(eq(duties.id, dutyId))
  })
}
