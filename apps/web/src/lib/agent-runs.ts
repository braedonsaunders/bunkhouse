import 'server-only'
import { randomUUID } from 'node:crypto'
import { and, desc, eq, gte, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { ModelMessage } from 'ai'
import {
  LIVE_TOOL_DEADLINE_MS,
  defineAbility,
  runAgent,
  type Ability,
  type ActionCategory,
  type AgentProfile,
  type AutonomyLevel,
  type AutonomyResolver,
  type BoundProcedure,
  type BudgetMeter,
  type CompanyProfile,
  type GovernanceState,
  type MemoryNote,
  type RunInput,
  type RunInputImage,
  type RunAgentProgress,
  type RunOutcome,
  type RunSink,
  type ExternalEffectGate,
  type BoundSkill,
  takeAbilityFrame,
  redactSecretValue,
} from '@bunkhouse/runtime'
import {
  executeExternalEffect,
  runWithFencedLease,
  type ExecutionLease,
  ExecutionLeaseLostError,
  ExecutionLeaseUnavailableError,
} from '@braedonsaunders/appkit-events'
import {
  assignments,
  autonomySettings,
  approvals,
  duties,
  mailMessages,
  mailThreads,
  mailboxAccounts,
  people,
  procedureRevisions,
  procedures,
  runEvents,
  runs,
  tokenSpend,
  type ApprovalPayload,
  type RunTrigger,
} from '../db/schema'
import { db } from '../db/client'
import { loadInternalAddressTest } from './internal-addresses'
import { ingestChatRunAttachments } from './chat-attachments'
import { matchesInternalDomain } from './internal-domains'
import { takeInbox } from './colleague-inbox'
import { hopsOf } from './colleague-post'
import { resolveAgentAiConfig } from './ai'
import { companyPromptProfile, getCompanyIdentity } from './company-identity'
import { getMailSignature } from './mail-signature'
import { assembleAbilities } from './agent-abilities'
import { priceSpend } from './pricing'
import { sendNewMail, sendReplyInThread } from './mailbox'
import { pinnedNotes, retrieveNotes } from './memory'
import { describeToolCall } from './call-activity'
import { isWithinWorkingHours } from './working-hours'
import { getFileBytes, getFileRecord } from './files'
import { closeBrowserSession } from './browser-use'
import { closeDeskSession } from './desk'
import { readSkillBundle, skillsForAgent, type BoundSkillRow } from './skills'
import { agentBinding, bindsToAgent, type AgentBinding } from './assignment'
import { PersonNotWorkingError, isPersonNotWorking, workRefusal, type WorkRefusal } from './person-work'
import { appendRunEvent } from './run-events'
import {
  externalEffectStore,
  finalizeRunAttempt,
  finishRunAttempt,
  runExecutionLeaseStore,
  recordRunAttemptEvent,
  resolveExternalEffectIdempotencyKey,
} from './run-execution'
import { materializeSkillBundle } from './workspace'
import { registerRunScreenRoom } from './run-screen-room'



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

/**
 * The Logbook, recalled for one piece of work: the pinned tier always rides
 * into the prompt, the rest is scored against what the agent is about to do.
 * Assumes an active tenant scope — every caller already has one.
 */
/**
 * How many characters of logbook may ride along in a run's context. Roughly
 * 15k tokens — generous for what an agent genuinely needs to remember, and a
 * hard stop on a back catalogue that would otherwise grow without limit.
 */
const MEMORY_CONTEXT_BUDGET = 60_000

export async function runMemories(args: {
  tenantId: string
  agent: AgentBinding
  /** What the work is about, in the agent's own terms. */
  query: string
}, deps: {
  pinned?: (args: { tenantId: string; agent: AgentBinding }) => Promise<{
    id: string
    scope: 'agent' | 'company'
    slug: string
    title: string
    body: string
  }[]>
  relevant?: (args: { tenantId: string; agent: AgentBinding; query: string }) => Promise<{
    id: string
    scope: 'agent' | 'company'
    slug: string
    title: string
    body: string
  }[]>
  onRecallFailure?: (error: unknown) => Promise<void>
} = {}): Promise<MemoryNote[]> {
  // Pinned notes are the operator-declared always-in-context tier. If those
  // cannot be read, stopping is safer than quietly omitting them. Ranked
  // relevance is optional enrichment: after its own safe retry, a failure may
  // fall back to pinned notes and leave evidence without blocking all work.
  const pinned = await (deps.pinned ?? pinnedNotes)({ tenantId: args.tenantId, agent: args.agent })
  let retrieved: Awaited<ReturnType<NonNullable<typeof deps.relevant>>> = []
  try {
    retrieved = await (deps.relevant ?? retrieveNotes)({
      tenantId: args.tenantId,
      agent: args.agent,
      query: args.query,
    })
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error
    console.error(
      '[memory] relevant recall unavailable; continuing with pinned notes:',
      cause instanceof Error ? cause.message : String(cause),
    )
    await deps.onRecallFailure?.(error)
  }
  const candidates = [...pinned, ...retrieved.filter((r) => !pinned.some((p) => p.id === r.id))]

  // Bounded, because a logbook only ever grows and this goes into EVERY step's
  // context. One agent reached an average of 128,000 input tokens per model
  // call — one call touched a million — against 10,000 for a colleague doing
  // comparable work, and the difference was its own back catalogue of notes
  // about what was broken, retrieved in full, every step, and re-read at the
  // full price of the window. Worse, it compounds: each failure writes another
  // note, which makes the next run more expensive than the last.
  //
  // Pinned notes come first and are never dropped — that is what pinning is —
  // and retrieval fills what is left, best match first. A note that does not
  // fit is not lost; it is in the logbook, and search_memory will find it.
  const kept: MemoryNote[] = []
  let budget = MEMORY_CONTEXT_BUDGET
  for (const note of candidates) {
    const cost = note.title.length + note.body.length
    if (cost > budget) {
      if (kept.length === 0) {
        // A single note larger than the whole budget still has to be readable,
        // so it goes in cut rather than dropped, and says that it was cut.
        kept.push({
          scope: note.scope,
          slug: note.slug,
          title: note.title,
          body: `${note.body.slice(0, budget)}\n\n[…this note is longer than the space there is for it; search_memory has the rest.]`,
        })
        budget = 0
      }
      continue
    }
    budget -= cost
    kept.push({ scope: note.scope, slug: note.slug, title: note.title, body: note.body })
  }
  return kept
}

/**
 * Everything a governed run stands on that the work itself does not decide:
 * who the agent is, the company it speaks for, the procedures bound to it, the
 * autonomy dial, the salary meter, and where token spend is filed. Email runs,
 * duty runs and work handed over on a live call all assemble it here, so an
 * agent is the same colleague wherever you reach it.
 */
export type RunFoundation = {
  agent: AgentProfile
  company: CompanyProfile
  procedures: BoundProcedure[]
  /** Skills bound to this agent — indexed in the prompt, loaded on demand. */
  skills: BoundSkill[]
  /** Writes a loaded skill's bundle into this agent's workspace. */
  materializeSkill: (skill: BoundSkill) => Promise<{ path: string; files: string[] }>
  autonomy: AutonomyResolver
  budget: BudgetMeter
  spend: RunSink['spend']
}

/**
 * The autonomy dial for one agent, resolved. Missing categories are
 * 'approval' — the safe posture for anything nobody configured, and the only
 * place that default is written down. Assumes an active tenant scope.
 */
export async function autonomyDial(args: { tenantId: string; personId: string }): Promise<AutonomyResolver> {
  const app = db()
  const rows = await app.db.select().from(autonomySettings).where(eq(autonomySettings.personId, args.personId))
  const dial = new Map(rows.map((r) => [r.category, r.level]))
  return (category: ActionCategory): AutonomyLevel => dial.get(category) ?? 'approval'
}

/**
 * File an approval request against a run — once per distinct action, however
 * many times the agent tries it. A model told "queued for approval" retries
 * the identical call, and a manager should find one decision to make, not a
 * column of the same one. The check is on the record, not on an in-memory map,
 * so it holds across resumed runs and across processes. Assumes an active
 * tenant scope.
 */
export async function requestApproval(args: {
  tenantId: string
  runId: string
  personId: string
  category: ActionCategory
  description: string
  action: Record<string, unknown>
}): Promise<{ approvalId: string; alreadyRequested: boolean }> {
  const app = db()
  const toolCallId = typeof args.action.toolCallId === 'string' ? args.action.toolCallId : null
  const [existing] = await app.db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.runId, args.runId),
        eq(approvals.status, 'pending'),
        toolCallId
          ? sql`${approvals.payload}->'action'->>'toolCallId' = ${toolCallId}`
          : sql`${approvals.payload}->'action' = ${JSON.stringify(args.action)}::jsonb`,
      ),
    )
    .limit(1)
  if (existing) return { approvalId: existing.id, alreadyRequested: true }
  const [row] = await app.db
    .insert(approvals)
    .values({
      tenantId: args.tenantId,
      runId: args.runId,
      personId: args.personId,
      category: args.category,
      payload: { description: args.description, action: args.action },
    })
    .onConflictDoNothing()
    .returning({ id: approvals.id })
  if (row) return { approvalId: row.id, alreadyRequested: false }
  const [raced] = await app.db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(
      eq(approvals.runId, args.runId),
      eq(approvals.status, 'pending'),
      toolCallId
        ? sql`${approvals.payload}->'action'->>'toolCallId' = ${toolCallId}`
        : sql`${approvals.payload}->'action' = ${JSON.stringify(args.action)}::jsonb`,
    ))
    .limit(1)
  if (!raced) throw new Error('The approval request could not be recorded.')
  return { approvalId: raced.id, alreadyRequested: true }
}

/**
 * Assemble that foundation. Assumes an active tenant scope. Returns a reason
 * rather than throwing when the agent cannot run at all — the caller decides
 * whether that is a failed run row or a sentence said out loud on a call.
 */
export async function assembleRunFoundation(args: {
  tenantId: string
  person: typeof people.$inferSelect
  /** The run token spend is filed against. */
  runId: string
}): Promise<{ ok: true; foundation: RunFoundation } | { ok: false; reason: string }> {
  const app = db()
  const { tenantId, person, runId } = args

  const ai = await resolveAgentAiConfig(tenantId, person.id)
  if (!ai) return { ok: false, reason: 'No model assigned — set a provider and model on the profile.' }

  const autonomy = await autonomyDial({ tenantId, personId: person.id })
  const directory = await app.db.select().from(people).where(eq(people.status, 'active'))
  const identity = await getCompanyIdentity(tenantId)
  const signature = await getMailSignature(tenantId)
  const signatureAppended = signature.enabled && signature.compiledHtml.trim().length > 0
  const skills = await boundSkills(tenantId, person)

  return {
    ok: true,
    foundation: {
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
        timezone: person.timezone ?? null,
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
      procedures: await boundProcedures(tenantId, person),
      skills: skills.skills,
      materializeSkill: skillMaterializer({ tenantId, personId: person.id, runId, rows: skills.rows }),
      autonomy,
      budget: {
        remainingUsd: async () => (person.salary?.monthlyUsd ?? 50) - (await monthSpendUsd(tenantId, person.id)),
        overagePolicy: person.salary?.overagePolicy ?? 'ask',
      },
      spend: async (usage) => {
        const priced = await priceSpend({
          tenantId,
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(usage.costUsd === undefined ? {} : { reportedCostUsd: usage.costUsd }),
        })
        await app.db.insert(tokenSpend).values({
          tenantId,
          personId: person.id,
          runId,
          provider: usage.provider,
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedInputTokens: usage.cachedInputTokens ?? 0,
          ...priced,
        })
      },
    },
  }
}

/** Active procedure revisions bound to a person — shared with the voice agent. */
export async function boundProcedures(tenantId: string, person: typeof people.$inferSelect): Promise<BoundProcedure[]> {
  const app = db()
  const heads = await app.db.select().from(procedures).where(eq(procedures.status, 'active'))
  const applicable = heads.filter((p) => bindsToAgent(p.assignment, agentBinding(person)))
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
 * The skills bound to a person — shared with the voice agent, so an agent that
 * can lay out a proposal by email can do it on a call too. Only the name and
 * description reach the prompt; `body` travels along for load_skill to hand
 * over without a second query mid-run.
 *
 * Returns the underlying rows alongside, because the materializer needs the
 * skill's id and version and resolving assignment a second time to find them
 * would be both wasteful and a chance to resolve it differently.
 */
export async function boundSkills(
  tenantId: string,
  person: typeof people.$inferSelect,
): Promise<{ skills: BoundSkill[]; rows: BoundSkillRow[] }> {
  const rows = await skillsForAgent({ tenantId, agent: agentBinding(person) })
  return {
    rows,
    skills: rows.map(({ skill, revision, fileCount }) => ({
      slug: skill.slug,
      title: skill.title,
      description: skill.description,
      version: revision.version,
      body: revision.body,
      hasFiles: fileCount > 0,
    })),
  }
}

/**
 * Writes a loaded skill's bundle into the agent's workspace. Reading the bytes
 * is deferred to the moment a skill is actually loaded — most runs load none,
 * and pulling every assigned bundle out of storage up front would be paid for
 * on every run to serve the few that need it.
 */
export function skillMaterializer(args: {
  tenantId: string
  personId: string
  runId: string
  rows: BoundSkillRow[]
}): (skill: BoundSkill) => Promise<{ path: string; files: string[] }> {
  const bySlug = new Map(args.rows.map((row) => [row.skill.slug, row]))
  return async (skill) => {
    const match = bySlug.get(skill.slug)
    if (!match || match.fileCount === 0) return { path: '', files: [] }
    const files = await readSkillBundle({
      tenantId: args.tenantId,
      skillId: match.skill.id,
      version: match.skill.currentVersion,
    })
    if (files.length === 0) return { path: '', files: [] }
    return materializeSkillBundle({
      tenantId: args.tenantId,
      personId: args.personId,
      runId: args.runId,
      slug: skill.slug,
      files,
    })
  }
}

/**
 * Everyone on a thread who is not the agent holding the mailbox, lowercased.
 * The thread's participants are the whole of who a reply reaches.
 */
async function threadCounterparties(tenantId: string, threadId: string): Promise<string[]> {
  const app = db()
  const [row] = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ participants: mailThreads.participants, mailbox: mailboxAccounts.address })
      .from(mailThreads)
      .innerJoin(mailboxAccounts, eq(mailboxAccounts.id, mailThreads.mailboxId))
      .where(eq(mailThreads.id, threadId)),
  )
  if (!row) return []
  const own = row.mailbox.trim().toLowerCase()
  return row.participants
    .map((participant) => participant.address.trim().toLowerCase())
    .filter((address) => address && address !== own)
}

/**
 * Is every address this reply reaches one of ours? Answered before the tool
 * runs, because the dial is resolved when the ability is built.
 *
 * An empty thread is treated as external: with nobody identifiable on it, the
 * cautious answer is the one that asks a human.
 */
export async function threadIsInternal(tenantId: string, threadId: string): Promise<boolean> {
  const [counterparties, isInternalAddress] = await Promise.all([
    threadCounterparties(tenantId, threadId),
    loadInternalAddressTest(tenantId),
  ])
  return counterparties.length > 0 && counterparties.every((address) => isInternalAddress(address))
}

/**
 * The thread-bound reply ability: only email-triggered runs carry it, and the
 * approval executor rebuilds it to carry out an approved reply.
 *
 * `internal` is resolved from who is actually on the thread. It used to be
 * hardcoded external, which is the same defect `send_email` was fixed for and
 * this one kept: an agent replying to its own CFO — a person in the directory,
 * writing from the company's own domain — had to wait for sign-off to answer.
 * On one tenant that produced a loop, because the approval confirmation came
 * back as mail the agent then had to reply to, needing another approval.
 */
export function replyToThreadAbility(args: {
  tenantId: string
  threadId: string
  runId: string
  /** True when every counterparty on the thread is staff or at our domains. */
  internal?: boolean
}): Ability {
  const { tenantId, threadId, runId } = args
  return defineAbility({
    name: 'reply_to_thread',
    description:
      'Send your reply on the email thread you are handling. The body is sent as-is from your mailbox. Attach files you produced by id with attachFileIds.',
    category: args.internal ? 'internal_email' : 'external_email',
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
 * A deliverable is a day's work, not an errand: research, draft, render,
 * revise, deliver. Sixty steps was an errand — the run was cut off with the
 * document half written. This is the runaway backstop only; what actually
 * governs the length of the work is the salary budget, checked every step.
 */
export const ASSIGNMENT_MAX_STEPS = 600

/**
 * The live disposition: work somebody is waiting on right now, inside a record
 * the caller already owns.
 *
 * There is one engine. What changes between an assignment and a request made
 * on the phone is not how the work runs — same governed loop, same dial, same
 * approvals, same metering, same ledger — but when the answer is wanted and
 * where it goes. Deferred work is an assignment: queued, run by the worker
 * process, delivered by email. Live work runs here and now, in the process
 * holding the conversation, and its progress is narrated as it happens.
 *
 * So a live run does not open a run of its own: it joins the call's, appending
 * through the caller's own sink (which numbers the events and narrates them),
 * drawing on the ability set the call assembled once, and stopping when the
 * caller's signal fires. The run row's lifecycle stays with the call.
 */
export type LiveRun = {
  /** The run this work belongs to — the call's. */
  runId: string
  /** The caller's ledger. It owns the sequence numbers, and it narrates. */
  event: RunSink['event']
  /**
   * The abilities the call assembled once and shares with its talker.
   * Reassembling them per request would reconnect every MCP integration
   * mid-conversation, which is latency a caller can hear.
   */
  abilities: Ability[]
  /** Credentials held by the call's already-connected adapters. */
  secrets: string[]
  /** Fires when the call ends: work in flight stops rather than outliving it. */
  abortSignal: AbortSignal
}

type ExternalEffectInvocation<T> = {
  toolName: string
  category: ActionCategory
  idempotencyKey: string
  idempotencyScope: 'invocation' | 'domain'
  request: unknown
  signal: AbortSignal
  operation: (signal: AbortSignal) => Promise<T>
}

/**
 * Turn a database cancellation into the same AbortSignal used by the model,
 * tool deadline, and external-effect boundary. The run row is authoritative;
 * the timer only controls how quickly this process learns about the change.
 */
async function withRunCancellation<T>(
  runId: string,
  parent: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const app = db()
  const controller = new AbortController()
  const abortParent = () => controller.abort(parent?.reason)
  if (parent?.aborted) abortParent()
  else parent?.addEventListener('abort', abortParent, { once: true })
  let checking = false
  const timer = setInterval(() => {
    if (checking || controller.signal.aborted) return
    checking = true
    void app.db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
      .then(([row]) => {
        if (row?.status === 'cancelled') controller.abort(new DOMException('Run cancelled.', 'AbortError'))
      })
      .catch(() => undefined)
      .finally(() => {
        checking = false
      })
  }, 500)
  try {
    return await work(controller.signal)
  } finally {
    clearInterval(timer)
    parent?.removeEventListener('abort', abortParent)
    if (!controller.signal.aborted) controller.abort()
  }
}



/**
 * Put what colleagues have said in front of the run, without pretending it is
 * the instruction. It is context the agent should act on if it needs acting
 * on — the same way a person reads their messages before getting on with the
 * day, not instead of it.
 */
function withInbox(input: RunInput, messages: string): RunInput {
  const preamble = `While you were away, colleagues left you these. Read them, act on anything that genuinely needs it, and do not reply merely to acknowledge — an acknowledgement is not worth anybody's time.\n\n${messages}\n\n---\n\n`
  if (input.type === 'manual') return { ...input, instruction: `${preamble}${input.instruction}` }
  return input
}

/**
 * Which human ask this run descends from, if any.
 *
 * Derived work says so in its own trigger: an assignment names the assignment
 * (whose source carries the root), a follow-up names the run whose approval it
 * continues, a delegation names the run that delegated. Everything else — a
 * call, an inbound email, a duty a person configured — is the ask itself, and
 * roots the tree.
 *
 * Assumes an active tenant scope.
 */
async function resolveRootRun(trigger: RunTrigger): Promise<string | null> {
  const app = db()
  const rootOf = async (runId: string): Promise<string> => {
    const [row] = await app.db.select({ root: runs.rootRunId }).from(runs).where(eq(runs.id, runId))
    // The parent's root, or the parent itself when the parent was the ask.
    return row?.root ?? runId
  }
  if (trigger.type === 'approval_followup') return rootOf(trigger.originRunId)
  if (trigger.type === 'credential_followup') return rootOf(trigger.originRunId)
  if (trigger.type === 'delegation') return rootOf(trigger.runId)
  if (trigger.type === 'assignment') {
    const [row] = await app.db
      .select({ source: assignments.source })
      .from(assignments)
      .where(eq(assignments.id, trigger.assignmentId))
    const source = row?.source
    if (source?.kind === 'delegation') {
      return source.rootRunId ?? (source.runId ? rootOf(source.runId) : null)
    }
    return null
  }
  return null
}

/**
 * Refuse to start work for somebody who may not do it — and leave the evidence.
 *
 * A refusal is never silence. It opens a run of its own, failed on arrival,
 * carrying the reason as its summary and as the first entry in its ledger, so
 * the work that did NOT happen is on the observatory beside the work that did
 * and an operator can see that their offboarding took effect. The run row is
 * also what makes the refusal idempotent for inbound mail: it carries the
 * message id in its trigger, so the pending-mail sweep does not offer the same
 * message again on its next pass, for ever.
 *
 * A live run has no row to open — the call opened one before the caller
 * spoke, and it belongs to the call — so it is refused without a record here
 * and the caller closes its own.
 *
 * Assumes an active tenant scope.
 */
async function refuseRun(args: {
  tenantId: string
  person: typeof people.$inferSelect
  trigger: RunTrigger
  refusal: WorkRefusal
  live: LiveRun | null
}): Promise<PersonNotWorkingError> {
  const app = db()
  if (args.live) return new PersonNotWorkingError(args.person.id, args.refusal)
  const [row] = await app.db
    .insert(runs)
    .values({
      tenantId: args.tenantId,
      personId: args.person.id,
      status: 'failed',
      trigger: args.trigger,
      summary: args.refusal.reason.slice(0, 500),
      finishedAt: new Date(),
    })
    .returning({ id: runs.id })
  const runId = row?.id ?? null
  if (runId) {
    await appendRunEvent(app.db, {
      tenantId: args.tenantId,
      runId,
      kind: 'error',
      payload: { message: args.refusal.reason },
    })
  }
  return new PersonNotWorkingError(args.person.id, args.refusal, runId)
}

/**
 * Execute one unit of work for an agent, end to end: run row, governed loop,
 * event/spend ledger, approval suspension, outcome. Runs inside the caller's
 * process (web action, background worker, or the voice agent) — all state is
 * in the database.
 *
 * With `resumeRunId`, no new run row is created: the suspended run's stored
 * transcript becomes the prior context, the event sequence continues, and the
 * input (normally an approval decision) is appended as the next turn.
 *
 * With `live`, no run row is created or closed at all — see {@link LiveRun}.
 */
export async function executeAgentRun(args: {
  tenantId: string
  personId: string
  /** How the work arrived. Not persisted under `live`: the call's run owns it. */
  trigger: RunTrigger
  input: RunInput
  resumeRunId?: string
  maxSteps?: number
  counterparty?: { name?: string; address?: string }
  live?: LiveRun
  /** Ephemeral presentation progress; durable evidence remains in run_events. */
  progress?: RunAgentProgress
}): Promise<{ runId: string; outcome: RunOutcome }> {
  const app = db()
  const live = args.live ?? null
  // NO run sits inside one long transaction. This was true of live runs first,
  // for the reason that is obvious on a phone call — nothing a transaction
  // writes is visible until it commits, so the call stage showed a blank
  // activity feed until the work finished — and it is just as true of the rest
  // now that a run may legitimately work for hours rather than a couple of
  // dozen steps.
  //
  // Three symptoms, one cause. An offline run was invisible in the observatory
  // for its entire length, so nobody could watch work in progress. It could not
  // be stopped, because Stop could not find a row that did not exist yet, and
  // the loop's own cancellation check could only see its transaction's
  // uncommitted copy of itself. And it pinned a Postgres connection open, in
  // transaction, for as long as the work took.
  //
  // Measured: a fifty-second duty run was invisible to a second connection for
  // all fifty of them, appearing only once it was over.
  //
  // What the transaction bought was all-or-nothing, and that was the wrong
  // trade for a ledger. Run events are append-only history; a crash erasing
  // them is not a clean rollback, it is losing the record of what happened.
  // The catch below is what replaces it: a failure now leaves the run saying
  // so, which is also what the abandoned-work sweep has always assumed it would
  // find.
  const scope = app.withTenantContext
  return scope(args.tenantId, async () => {
    const [person] = await app.db.select().from(people).where(eq(people.id, args.personId))
    if (!person) throw new Error('Run target is not an agent.')

    // The employment gate, and the only one there is. Every door into work —
    // inbound mail, chat, the Slack/Teams bridge, a duty, an assignment, a
    // decided approval, a live call — arrives here, so this is where a person
    // who may not work is stopped. Before the run row, because an agent that
    // has been stood down must not open one.
    const refusal = workRefusal(person)
    if (refusal) throw await refuseRun({ tenantId: args.tenantId, person, trigger: args.trigger, refusal, live })

    let runId: string
    let priorMessages: unknown[] = []
    if (live) {
      runId = live.runId
    } else if (args.resumeRunId) {
      const [existing] = await app.db.select().from(runs).where(eq(runs.id, args.resumeRunId))
      if (!existing || existing.personId !== person.id) throw new Error('Run to resume not found.')
      runId = existing.id
      priorMessages = existing.transcript ?? []
      await app.db
        .update(runs)
        .set({ status: 'running', finishedAt: null, waiting: null })
        .where(eq(runs.id, runId))
    } else {
      // The human ask this descends from. A call, an inbound email, a duty
      // somebody configured: those ARE the ask, and root stays null so the run
      // is its own root. Anything derived — an assignment, a delegation, the
      // reply to one — inherits it, so what a single request cost can be
      // totalled however far the work spread, and bounded before it spreads
      // further.
      const rootRunId = await resolveRootRun(args.trigger)
      const [run] = await app.db
        .insert(runs)
        .values({
          tenantId: args.tenantId,
          personId: person.id,
          trigger: args.trigger,
          ...(rootRunId ? { rootRunId } : {}),
        })
        .returning({ id: runs.id })
      runId = run!.id
    }
    const recordEvent: RunSink['event'] =
      live?.event ??
      (async (event) => {
        const { kind, ...payload } = event
        await appendRunEvent(app.db, {
          tenantId: args.tenantId,
          runId,
          kind: kind as (typeof runEvents.$inferInsert)['kind'],
          payload,
        })
      })

    let runInput = args.input
    const attempt: { lease: ExecutionLease | null; outcome: RunOutcome | null } = { lease: null, outcome: null }
    // From here the run has a row, and a failure has to leave it saying so.
    // Nothing rolls back any more: a crash used to erase the run and its whole
    // ledger, which is the opposite of an append-only history and left the
    // abandoned-work sweep looking for rows that no longer existed.
    try {
      if (runInput.type === 'chat' && runInput.attachments?.length) {
        runInput = {
          ...runInput,
          attachments: await ingestChatRunAttachments({
            tenantId: args.tenantId,
            personId: person.id,
            runId,
            attachments: runInput.attachments,
          }),
        }
      }
      const built = await assembleRunFoundation({ tenantId: args.tenantId, person, runId })
      if (!built.ok) {
        await recordEvent({ kind: 'error', message: built.reason })
        if (!live) {
          await app.db
            .update(runs)
            .set({ status: 'failed', finishedAt: new Date(), summary: built.reason.slice(0, 500) })
            .where(eq(runs.id, runId))
        }
        return {
          runId,
          outcome: {
            status: 'failed',
            error: built.reason,
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [],
          },
        }
      }
      const foundation = built.foundation
      const sink: RunSink = { event: recordEvent, spend: foundation.spend }

      // What this task is about — what the Logbook is recalled against.
      const retrievalQuery =
        runInput.type === 'email'
          ? `${runInput.threadSubject} ${runInput.conversation.slice(-400)}`
          : runInput.type === 'duty'
            ? `${runInput.dutyTitle} ${runInput.instruction}`
            : runInput.type === 'chat'
              ? `${runInput.message} ${(runInput.attachments ?? []).map((file) => file.filename).join(' ')}`
              : runInput.type === 'delegation'
                ? runInput.instruction
                : runInput.type === 'assignment'
                  ? `${runInput.title} ${runInput.spec.slice(0, 400)}`
                  : runInput.type === 'approval_decision'
                    ? runInput.description
                  : runInput.type === 'reply_received'
                    ? runInput.question
                    : runInput.type === 'credential_stored'
                      ? `${runInput.systemName} ${runInput.purpose}`
                      : runInput.instruction
      const memories = await runMemories(
        { tenantId: args.tenantId, agent: agentBinding(person), query: retrievalQuery },
        {
          onRecallFailure: async () => {
            await recordEvent({
              kind: 'error',
              message: 'Relevant logbook recall was temporarily unavailable; continuing with pinned memory.',
            })
          },
        },
      )

      // Anything a colleague has said since this agent last worked. Read here,
      // once, and marked read in the same breath — a message delivered twice is
      // how an agent answers the same thing over and over. Deliberately NOT in
      // the logbook: that is where an agent keeps what it has learned, and a
      // message is not a lesson.
      const inbox = live ? [] : await takeInbox({ personId: person.id })
      const [thisRun] = await app.db.select({ root: runs.rootRunId }).from(runs).where(eq(runs.id, runId))
      const rootOfThisRun = thisRun?.root ?? null
      const handoffDepth =
        args.trigger.type === 'assignment'
          ? await (async () => {
              const [row] = await app.db
                .select({ source: assignments.source })
                .from(assignments)
                .where(eq(assignments.id, args.trigger.type === 'assignment' ? args.trigger.assignmentId : ''))
              return hopsOf(row?.source ?? null)
            })()
          : 0

      // The shared capability set. A live run is handed the one its call already
      // assembled; everything else assembles its own, plus ask_and_wait — an
      // async run can genuinely pause on a person's answer, a live one cannot.
      const waitState: GovernanceState = {
        pendingApprovalId: null,
        pendingCredentialRequestId: null,
        pendingWait: null,
      }
      const allowStandingSchedules =
        args.trigger.type === 'chat' ||
        (args.trigger.type === 'manual' && Boolean(args.trigger.requestedBy)) ||
        (args.trigger.type === 'email' && (await threadIsInternal(args.tenantId, args.trigger.threadId)))
      const assembled = live
        ? null
        : await assembleAbilities({
            tenantId: args.tenantId,
            person,
            runId,
            assignmentSource:
              args.trigger.type === 'email' ? { kind: 'mail', threadId: args.trigger.threadId } : { kind: 'manual' },
            // A run that is itself the ask roots the tree; one derived from an
            // ask passes the same root on.
            rootRunId: rootOfThisRun ?? runId,
            // How far this run already is from the person who asked. Without it
            // every handoff reported itself as the first, so the depth guard
            // only ever saw "1" and never stopped anything.
            handoffDepth,
            allowStandingSchedules,
            ...(args.trigger.type === 'chat' && args.trigger.conversationId.startsWith('web:')
              ? { chatThreadId: args.trigger.conversationId.slice('web:'.length) }
              : {}),
            ...(args.counterparty ? { counterparty: args.counterparty } : {}),
            waitState,
          })
      for (const failure of assembled?.integrationFailures ?? []) {
        await sink.event({ kind: 'message', text: `Integration unavailable — ${failure}` })
      }
      const abilities: Ability[] = [...(assembled?.abilities ?? live!.abilities)]
      if (args.trigger.type === 'email') {
        abilities.push(
          replyToThreadAbility({
            tenantId: args.tenantId,
            threadId: args.trigger.threadId,
            runId,
            internal: await threadIsInternal(args.tenantId, args.trigger.threadId),
          }),
        )
      }

      const effectSecrets = [
        ...(assembled?.secrets ?? live?.secrets ?? []),
        ...(process.env.BUNKHOUSE_DESK_TOKEN ? [process.env.BUNKHOUSE_DESK_TOKEN] : []),
      ]
      const runLoop = (lease: ExecutionLease, signal: AbortSignal) => {
        const stopRunScreen = live
          ? null
          : registerRunScreenRoom({
              tenantId: args.tenantId,
              runId,
              onError: (message) => void sink.event({ kind: 'message', text: `Live browser view unavailable — ${message}` }),
            })
        const effectOrdinals = new Map<string, number>()
        const effects: ExternalEffectGate = {
          execute: async <T>(effect: ExternalEffectInvocation<T>) => {
            const kind = `${effect.category}:${effect.toolName}`
            const ordinal = effectOrdinals.get(kind) ?? 0
            effectOrdinals.set(kind, ordinal + 1)
            const idempotencyKey = await resolveExternalEffectIdempotencyKey({
              tenantId: args.tenantId,
              runId,
              attemptId: lease.attemptId,
              kind,
              invocationKey: effect.idempotencyKey,
              scope: effect.idempotencyScope,
              request: { toolName: effect.toolName, category: effect.category, input: effect.request },
              ordinal,
            })
            return executeExternalEffect<unknown, T>({
              store: externalEffectStore<T>(args.tenantId),
              intent: {
                tenantId: args.tenantId,
                runId,
                attemptId: lease.attemptId,
                kind,
                idempotencyKey,
                request: { toolName: effect.toolName, category: effect.category, input: effect.request },
              },
              signal: effect.signal,
              sanitize: (value) => {
                const { rest } = takeAbilityFrame(value)
                return redactSecretValue(rest, effectSecrets)
              },
              // Existing adapters do not yet prove that a thrown transport
              // error occurred before the outside system accepted the work.
              // Treat that as uncertain and require reconciliation; retrying
              // an email, payment-adjacent write, or record mutation is worse.
              classifyError: () => 'ambiguous',
              execute: effect.operation,
            })
          },
        }
        return runAgent({
        runId,
        ...(args.progress ? { progress: args.progress } : {}),
        // Read straight from the row the operator's Stop writes, rather than a
        // flag held in this process: the run may be executing on a worker that
        // knows nothing about the request until it looks.
        //
        // This only works because no run is wrapped in a transaction any more
        // (see `scope` above). While offline runs were, the row did not exist
        // outside its own transaction until the run was over: Stop could not
        // find it, and this read saw nothing but the transaction's uncommitted
        // copy of itself. The check was right and had nothing to observe.
        isCancelled: async () => {
          const [row] = await app.db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId))
          return row?.status === 'cancelled'
        },
        ...(priorMessages.length ? { priorMessages: priorMessages as ModelMessage[] } : {}),
        ...(args.maxSteps ? { maxSteps: args.maxSteps } : {}),
        state: waitState,
        describeAction: describeToolCall,
        agent: foundation.agent,
        company: foundation.company,
        procedures: foundation.procedures,
        memories,
        skills: foundation.skills,
        materializeSkill: foundation.materializeSkill,
        abilities,
        input:
          inbox.length === 0
            ? runInput
            : withInbox(
                runInput,
                inbox
                  .map(
                    (message) =>
                      `From ${message.from} — ${message.subject}\n${message.body.trim()}`,
                  )
                  .join('\n\n'),
              ),
        autonomy: foundation.autonomy,
        approvals: {
          request: async (input) => {
            const { approvalId } = await requestApproval({
              tenantId: args.tenantId,
              runId,
              personId: person.id,
              category: input.category,
              description: input.description,
              action: input.action,
            })
            return { approvalId }
          },
        },
        budget: foundation.budget,
        sink,
        runSecrets: effectSecrets,
        abortSignal: signal,
        effects,
        ...(live ? { toolDeadlineMs: LIVE_TOOL_DEADLINE_MS } : {}),
      }).finally(async () => {
        // A live run borrows both: the integrations and the browser belong to the
        // call, which closes them once, when the call ends. Closing them here
        // would tear them out from under whatever else the caller has running.
        if (live) return
        await stopRunScreen?.()
        await assembled!.close()
        // A browser left open by the model is closed with the run, not leaked,
        // and the run's chapter of the desk ledger is stamped ended.
        await closeBrowserSession(runId)
        await closeDeskSession(runId).catch(() => {})
      })
      }

      const outcome = await withRunCancellation(runId, live?.abortSignal, (runSignal) =>
        runWithFencedLease({
          store: runExecutionLeaseStore(args.tenantId),
          runId,
          owner: `${live ? 'live' : 'worker'}:${randomUUID()}`,
          signal: runSignal,
          execute: async ({ lease, signal }) => {
            attempt.lease = lease
            const result = await runLoop(lease, signal)
            attempt.outcome = result
            return result
          },
        // Keep the lease heartbeat alive through every completion check and
        // through the terminal database transition. Returning true is the
        // commit: once this callback ends, the orchestrator may stop renewing.
        commit: async (lease, result) => {
          // The completion contract: work triggered by someone waiting for an
          // answer is not complete until an outbound reply or approval exists.
          let unmetContract: string | null = null
          if (result.status === 'completed' && args.trigger.type === 'email') {
            const [answered] = await app.db
              .select({ id: mailMessages.id })
              .from(mailMessages)
              .where(and(eq(mailMessages.runId, runId), eq(mailMessages.direction, 'outbound')))
              .limit(1)
            const [queued] = await app.db
              .select({ id: approvals.id })
              .from(approvals)
              .where(eq(approvals.runId, runId))
              .limit(1)
            if (!answered && !queued) {
              unmetContract =
                'Finished without answering the thread: no reply was sent and none was queued for approval. The sender has heard nothing.'
            }
          }

          const status =
            result.status === 'completed'
              ? unmetContract
                ? ('failed' as const)
                : ('completed' as const)
              : result.status === 'waiting_approval'
                ? ('waiting_approval' as const)
                : result.status === 'waiting_credential'
                  ? ('waiting_credential' as const)
                : result.status === 'waiting_reply'
                  ? ('waiting_reply' as const)
                  : result.status === 'cancelled'
                    ? ('cancelled' as const)
                    : ('failed' as const)
          if (unmetContract) await sink.event({ kind: 'error', message: unmetContract })

          if (result.status === 'waiting_approval' && person.reportsToId) {
            const [manager] = await app.db.select().from(people).where(eq(people.id, person.reportsToId))
            const [approval] = await app.db.select().from(approvals).where(eq(approvals.id, result.approvalId))
            if (manager && approval) {
              // The payload holds the exact action the executor will replay;
              // include its human-facing fields so a manager never approves a
              // vague label without seeing what will actually be sent.
              const shown = approvalContentPreview(approval.payload)
              const subject = `[BH#${approval.id.slice(0, 8)}] Approval needed: ${approval.category.replace('_', ' ')}`
              const text = `Hi ${manager.name.split(' ')[0]},\n\nI need your sign-off before I act:\n\n${approval.payload.description}${shown ? `\n\n${shown}` : ''}\n\nReply to this email with "approve" or "decline" (a short note after the word is kept for the record). You can also decide it in Bunkhouse under Approvals.\n\n${person.personality?.signoff ?? person.name}`
              try {
                await executeExternalEffect({
                  store: externalEffectStore<{ threadId: string }>(args.tenantId),
                  intent: {
                    tenantId: args.tenantId,
                    runId,
                    attemptId: lease.attemptId,
                    kind: 'system:approval_notification',
                    idempotencyKey: `${runId}:approval_notice:${approval.id}:${manager.email.toLowerCase()}`,
                    request: {
                      approvalId: approval.id,
                      manager: { name: manager.name, address: manager.email },
                      subject,
                      text,
                    },
                  },
                  signal: runSignal,
                  sanitize: (value) => {
                    const { rest } = takeAbilityFrame(value)
                    return redactSecretValue(rest, effectSecrets)
                  },
                  classifyError: () => 'ambiguous',
                  execute: () =>
                    sendNewMail({
                      tenantId: args.tenantId,
                      personId: person.id,
                      to: [{ name: manager.name, address: manager.email }],
                      subject,
                      text,
                      runId,
                    }),
                })
                await sink.event({
                  kind: 'message',
                  text: `Approval request emailed to ${manager.name} <${manager.email}>.`,
                })
              } catch (error) {
                await sink.event({
                  kind: 'message',
                  text: `Could not confirm delivery of the approval request (${error instanceof Error ? error.message : String(error)}); it is waiting in the Approvals queue.`,
                })
              }
            }
          }

          // A live run does not own the record it wrote into: the call opened
          // it and closes it later with the whole conversation's summary.
          if (live) {
            const attemptKind =
              result.status === 'cancelled' ? 'cancelled' : result.status === 'failed' ? 'failed' : 'completed'
            return finishRunAttempt(args.tenantId, lease, attemptKind, { outcome: result.status })
          }

          const parked =
            status === 'waiting_approval' || status === 'waiting_reply' || status === 'waiting_credential'
          return finalizeRunAttempt(
            args.tenantId,
            lease,
            {
              status,
              finishedAt: parked ? null : new Date(),
              // The transcript exists to resume a parked run; a finished run
              // keeps its ledger in run_events, not a model-conversation copy.
              transcript: parked ? (result.messages as unknown[]) : null,
              waiting:
                result.status === 'waiting_reply'
                  ? { ...result.wait, askedAt: new Date().toISOString() }
                  : null,
              summary:
                result.status === 'completed'
                  ? unmetContract
                    ? `${unmetContract} What it did instead: ${result.summary}`.slice(0, 500)
                    : result.summary.slice(0, 500)
                  : result.status === 'waiting_approval'
                    ? 'Waiting on an approval.'
                    : result.status === 'waiting_credential'
                      ? 'Waiting for a securely supplied credential.'
                    : result.status === 'waiting_reply'
                      ? `Waiting to hear back from ${result.wait.to}.`
                      : result.status === 'budget_paused'
                        ? 'Paused: salary budget exhausted.'
                        : result.status === 'cancelled'
                          ? 'Stopped by an operator.'
                          : result.error.slice(0, 500),
            },
            status === 'cancelled' ? 'cancelled' : status === 'failed' ? 'failed' : 'completed',
            { outcome: status },
          )
          },
        }),
      )
      return { runId, outcome }
    } catch (error) {
      // Another executor already owns this running row. That worker remains
      // authoritative; a duplicate delivery must not mark its run failed.
      if (error instanceof ExecutionLeaseUnavailableError) throw error
      if (error instanceof ExecutionLeaseLostError) {
        const [stopped] = await app.db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).limit(1)
        if (stopped?.status === 'cancelled') {
          return {
            runId,
            outcome: {
              status: 'cancelled',
              usage: attempt.outcome?.usage ?? { inputTokens: 0, outputTokens: 0 },
              messages: attempt.outcome?.messages ?? [],
            },
          }
        }
      }
      // A live run does not own its record — the call opened it and the call
      // closes it — so this marks only what it is responsible for.
      if (!live) {
        const reason = error instanceof Error ? error.message : String(error)
        await recordEvent({ kind: 'error', message: reason }).catch(() => undefined)
        const activeLease = attempt.lease
        if (activeLease && !(error instanceof ExecutionLeaseLostError)) {
          await finalizeRunAttempt(
            args.tenantId,
            activeLease,
            {
              status: 'failed',
              finishedAt: new Date(),
              transcript: null,
              waiting: null,
              summary: reason.slice(0, 500),
            },
            'failed',
            { error: reason },
          ).catch(() => false)
        } else if (!activeLease) {
          await app.db
            .update(runs)
            .set({ status: 'failed', finishedAt: new Date(), transcript: null, summary: reason.slice(0, 500) })
            .where(and(eq(runs.id, runId), ne(runs.status, 'cancelled')))
            .catch(() => undefined)
        }
      }
      const activeLease = attempt.lease
      if (activeLease) {
        const detail = { error: error instanceof Error ? error.message : String(error) }
        if (error instanceof ExecutionLeaseLostError) {
          await recordRunAttemptEvent({
            tenantId: args.tenantId,
            attemptId: activeLease.attemptId,
            kind: 'lease_lost',
            detail,
          }).catch(() => undefined)
        } else if (live) {
          await finishRunAttempt(args.tenantId, activeLease, 'failed', detail).catch(() => false)
        }
      }
      throw error
    }
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
  // A colleague who has never been added to the roster still writes from the
  // company's own domain, and a `staff_only` agent that turns them away is
  // refusing its own company's mail.
  const { internalDomains } = await getCompanyIdentity(tenantId)
  if (matchesInternalDomain(lower, internalDomains)) return 'staff'
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
 * What the manager is actually deciding, lifted out of the approval's own
 * replayable action. Content fields only — a draft's recipient, subject and
 * body are the decision; tool plumbing (thread ids, page sizes) is not.
 */
function approvalContentPreview(payload: ApprovalPayload): string | null {
  const input = (payload.action as { input?: unknown }).input
  if (input === null || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)
  const lines: string[] = []
  const to =
    text(record.to) ??
    (Array.isArray(record.to)
      ? record.to
          .map((entry) =>
            typeof entry === 'string' ? entry : text((entry as { address?: unknown } | null)?.address),
          )
          .filter(Boolean)
          .join(', ')
      : null)
  if (to) lines.push(`To: ${to}`)
  const subject = text(record.subject) ?? text(record.title)
  if (subject) lines.push(`Subject: ${subject}`)
  const body = text(record.body) ?? text(record.text) ?? text(record.message) ?? text(record.spec)
  if (body) {
    const clipped = body.length > 1500 ? `${body.slice(0, 1500)}\n[…trimmed]` : body
    lines.push('', '--- What will be sent ---', clipped, '--- End ---')
  }
  return lines.length > 0 ? lines.join('\n') : null
}

/**
 * A reply on an approval thread is control traffic, not conversation. The
 * worker's approval watcher reads it ("approve" / "decline") and decides the
 * approval; handing the same message to the agent as ordinary mail is how one
 * approved reply became an afternoon-long loop on a live tenant: the manager's
 * "approve" spawned a run with no context, that run wrote a confused reply to
 * the manager, the reply parked on a fresh approval, the manager approved
 * that, and around it went — three approvals deep before anyone understood
 * why the agent kept asking. The subject tag is the same one the watcher
 * matches decisions on.
 */
const NOT_AN_APPROVAL_THREAD = sql`${mailMessages.subject} not like '%[BH#%'`

/**
 * Inbound messages that never got a run: gate each by the agent's inbound
 * policy, then start a run — or record an auditable declined run so the
 * message is never silently reprocessed.
 */
export async function pendingInboundMessageIds(tenantId: string): Promise<string[]> {
  const app = db()
  const rows = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ id: mailMessages.id })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.direction, 'inbound'),
          NOT_AN_APPROVAL_THREAD,
          sql`not exists (select 1 from runs r where r.trigger->>'messageId' = ${mailMessages.id}::text)`,
          sql`not exists (select 1 from runs r where ${mailMessages.id} = any(r.consumed_message_ids))`,
        ),
      )
      .limit(100),
  )
  return rows.map((row) => row.id)
}

export async function startRunsForNewInbound(tenantId: string, onlyMessageId?: string): Promise<number> {
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
          NOT_AN_APPROVAL_THREAD,
          ...(onlyMessageId ? [eq(mailMessages.id, onlyMessageId)] : []),
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
        ...(waitingRun.trigger.type === 'assignment' ? { maxSteps: ASSIGNMENT_MAX_STEPS } : {}),
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
    try {
      await executeAgentRun({
        tenantId,
        personId: item.personId,
        trigger: { type: 'email', threadId: item.threadId, messageId: item.messageId },
        input: { type: 'email', threadSubject: subject, conversation, ...(images.length ? { images } : {}) },
        // The sender is who work committed on this thread defaults to.
        ...(item.sender ? { counterparty: { address: item.sender } } : {}),
      })
      started += 1
    } catch (error) {
      // An agent that may not work is not an incident either: the gate has
      // already written the refusal as a run against this message, which is
      // both the evidence and what keeps the sweep from offering the same
      // message again. Everything else on the mailbox carries on.
      if (isPersonNotWorking(error)) continue
      // Two schedulers can select the same unhandled message before either has
      // written its run row; the unique index decides between them. Losing that
      // race is the correct outcome, not an incident — the message is being
      // answered by the other pass — so this one steps over it quietly rather
      // than aborting the whole sweep and stranding the mail behind it.
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('runs_inbound_message_key')) throw error
    }
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
