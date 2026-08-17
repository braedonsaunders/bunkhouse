import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { unsealSecret } from '@braedonsaunders/appkit-crypto'
import {
  connectMcpServers,
  defineAbility,
  type Ability,
  type ActionCategory,
  type GovernanceState,
} from '@bunkhouse/runtime'
import { assignments, duties, memories, people, type AssignmentSource, type McpIntegrationEntry } from '../db/schema'
import { db } from '../db/client'
import { agentBinding, bindsToAgent, type AgentBinding } from './assignment'
import { findColleague, postToColleague } from './colleague-post'
import { loadInternalAddressTest, type InternalAddressTest } from './internal-addresses'
import { listMcpIntegrations } from './mcp-integrations'
import { mcpM2mHeaders, mcpOauthHeaders } from './mcp-oauth'
import { sendNewMail } from './mailbox'
import { createNote, retrieveNotes, supersedeNote } from './memory'
import { firstOccurrence, gapMinutes } from './duties'
import { readWebpage, webSearch } from './research'
import { documentAbilities } from './documents'
import { templateAbilities } from './document-templates'
import { workspaceAbilities } from './workspace'
import { deskAbilities, deskSupported } from './desk'
import { resolveDeskFeatures } from './desk-policy'
import { toolAbilities } from './tools'
import { sendSms, smsConfigured } from './sms'
import { chatAbilities } from './chat-bridge'
import { outboundCallAbilities } from './outbound-call'
import { browserAbilities } from './browser-use'
import { meetingAbilities } from './meetings'

/**
 * The one place an agent's working abilities are assembled — email runs, duty
 * runs, and live voice calls all draw from here, so an agent can do the same
 * work wherever you reach it. Governance (the autonomy dial, approvals) wraps
 * these at the call site; abilities carry only their action category.
 */

type PersonRow = typeof people.$inferSelect


/** Ceilings on what an agent may book for itself — see `schedule_task`. */
const MAX_SELF_SCHEDULED_DUTIES = 25
const MIN_SELF_SCHEDULE_GAP_MINUTES = 15

/**
 * How many times a repeat an agent booked for ITSELF may fire before it has to
 * be renewed deliberately.
 *
 * `maxRuns` was always available and no model ever set it, which is how one
 * agent ended up with two hourly duties — "check whether Dana's note has
 * arrived yet" and "re-check whether Dana's note has arrived yet" — firing
 * forty times overnight, each a full model run, polling for something that
 * could never arrive because the thing it was waiting on was broken. A person
 * checking hourly on something that has not moved in a day stops and asks
 * somebody; the schedule they set does not run for ever on its own.
 *
 * A standing routine belongs to the role, not to a run's follow-up impulse, so
 * this bounds only what an agent books for itself. Twelve is enough for "chase
 * this daily for a fortnight" and far short of all night, every night.
 */
export const MAX_SELF_SCHEDULED_REPEATS = 12

/** The logbook: save and search notes. Ungoverned — it is the agent's own head. */
export function memoryAbilities(args: { tenantId: string; person: PersonRow; runId: string }): Ability[] {
  const app = db()
  const { tenantId, person, runId } = args
  return [
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
              eq(memories.scope, 'agent'),
              eq(memories.personId, person.id),
              eq(memories.slug, slug),
              sql`${memories.validUntil} is null`,
            ),
          )
        if (existing) {
          await supersedeNote({ tenantId, oldNoteId: existing.id, title, body, author: 'agent', sourceRunId: runId })
          return { saved: true, superseded: existing.slug }
        }
        await createNote({
          tenantId,
          scope: 'agent',
          personId: person.id,
          kind,
          title,
          body,
          author: 'agent',
          importance,
          sourceRunId: runId,
        })
        return { saved: true }
      },
    }),
    defineAbility({
      name: 'search_memory',
      description:
        'Search your logbook and company knowledge for notes relevant to a query. Returns the best matches with their [[slug]] handles.',
      category: null,
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const found = await retrieveNotes({ tenantId, agent: agentBinding(person), query, limit: 6 })
        return {
          notes: found.map((n) => ({ slug: n.slug, kind: n.kind, title: n.title, body: n.body })),
        }
      },
    }),
  ]
}

/**
 * Web research: search and read. Ungoverned — both are read-only toward the
 * world (the page fetch is SSRF-guarded in lib/research). The search provider
 * is tenant configuration; without one, the keyless fallback serves.
 */
export function researchAbilities(args: { tenantId: string }): Ability[] {
  const { tenantId } = args
  return [
    defineAbility({
      name: 'web_search',
      description:
        'Search the web. Returns titles, URLs, and snippets. Use read_webpage on a result to get its full content.',
      category: null,
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const results = await webSearch(tenantId, query)
        return results.length > 0 ? { results } : { results: [], note: 'No results — try different terms.' }
      },
    }),
    defineAbility({
      name: 'read_webpage',
      description:
        'Fetch a public web page and return its readable text content. Quick and unseen — it is a fetch, not a visit, so nothing appears on a caller\'s screen and pages that need a click, a sign-in, or JavaScript come back empty or wrong. While you are on a call, prefer browser_open for anything the caller is waiting on: it is barely slower, it copes with real sites, and they can watch you do it.',
      category: null,
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => readWebpage(url),
    }),
  ]
}

/**
 * Fresh outbound email from the agent's own mailbox — the follow-up channel
 * for work agreed on a call or discovered mid-run. Two abilities because the
 * dial governs them separately: writing to a colleague is internal_email;
 * writing to anyone else is external_email.
 */
export function emailAbilities(args: {
  tenantId: string
  person: PersonRow
  runId: string
  /**
   * The human ask this run descends from, so anything handed to a colleague
   * carries it too and the cost of one request stays totalled in one place.
   */
  rootRunId?: string
  /**
   * Whether an address is one of ours — the staff directory plus the company's
   * own email domains. Loaded once when the abilities are assembled, because
   * the dial has to be resolved BEFORE the tool runs (an approval is filed
   * ahead of `execute`), so the answer cannot be a database round trip at call
   * time.
   */
  isInternalAddress: InternalAddressTest
}): Ability[] {
  const { tenantId, person, runId } = args
  const rootRunId = args.rootRunId

  const send = async (to: string, subject: string, body: string, attachFileIds?: string[]) => {
    await sendNewMail({
      tenantId,
      personId: person.id,
      to: [{ address: to }],
      subject,
      text: body,
      runId,
      ...(attachFileIds?.length ? { attachFileIds } : {}),
    })
    return { sent: true, to, ...(attachFileIds?.length ? { attachedFiles: attachFileIds.length } : {}) }
  }

  const attachFileIdsSchema = z
    .array(z.string())
    .optional()
    .describe('File ids of documents you created (or received) to attach to this email.')

  return [
    defineAbility({
      name: 'email_colleague',
      description:
        'Write to someone on staff — a person or an agent from the company directory. For an AI colleague this reaches them directly and they read it next time they are working; it does NOT start them working, and it does not need a mailbox. Use it to tell somebody something. When you need a colleague to actually do a piece of work, delegate it instead.',
      category: 'internal_email',
      inputSchema: z.object({
        to: z.string().describe('A staff email address from the directory'),
        subject: z.string(),
        body: z.string().describe('Plain text; sign it as yourself.'),
        attachFileIds: attachFileIdsSchema,
      }),
      execute: async ({ to, subject, body, attachFileIds }) => {
        const colleague = await findColleague(to)
        if (!colleague) {
          return { sent: false, reason: `${to} is not in the company directory — use send_email for outside addresses.` }
        }
        // An AI colleague is inside this system, and reaching them through a
        // mail provider and back was always a detour: it needed a mailbox
        // neither of them had, so every handoff between two agents failed and
        // they fell back to leaving each other notes and polling hourly for a
        // reply. They are handed the work directly now. A human colleague
        // genuinely does read email, so that path is untouched.
        if (colleague.kind === 'agent') {
          const posted = await postToColleague({
            tenantId,
            from: { id: person.id, name: person.name, title: person.title, email: person.email },
            toEmail: to,
            title: subject,
            body,
            runId,
            ...(rootRunId ? { rootRunId } : {}),
            kind: 'message',
          })
          if (!posted.posted) return { sent: false, reason: posted.reason }
          return {
            sent: true,
            to: posted.to,
            note: `${posted.to} will see this next time they are working. It is a message, not a job — it went to them directly, not by email, and it does not put them to work. If you need them to actually DO something, delegate it instead.`,
          }
        }
        return send(to, subject, body, attachFileIds)
      },
    }),
    defineAbility({
      name: 'send_email',
      description:
        'Send an email from your mailbox to any outside address. Attach files you have produced by id. If you address it to someone on staff it is treated as reaching a colleague, exactly as email_colleague would — you do not need to pick the right tool for that.',
      // Not a fixed label. An address in the company directory is a colleague
      // whichever tool reaches them, and calling that 'external_email' is how
      // ten runs ended up parked for hours awaiting sign-off to send mail to
      // dana@bunkhouse.local — while the identical message through
      // email_colleague went straight out on the internal dial. The dial that
      // applies depends on who is being written to, so it is resolved from who
      // is being written to.
      category: (input: { to: string }) =>
        args.isInternalAddress(input.to ?? '') ? 'internal_email' : 'external_email',
      inputSchema: z.object({
        to: z.string().describe('The recipient email address'),
        subject: z.string(),
        body: z.string().describe('Plain text; sign it as yourself.'),
        attachFileIds: attachFileIdsSchema,
      }),
      execute: async ({ to, subject, body, attachFileIds }) => {
        // Addressed to staff: the same internal handoff email_colleague makes,
        // so which tool the model reached for stops mattering. It also means
        // reaching a colleague never needs a mailbox — the thing that had
        // agents concluding their mail was broken and working around it.
        const colleague = await findColleague(to)
        if (colleague?.kind === 'agent') {
          const posted = await postToColleague({
            tenantId,
            from: { id: person.id, name: person.name, title: person.title, email: person.email },
            toEmail: to,
            title: subject,
            body,
            runId,
            ...(rootRunId ? { rootRunId } : {}),
            kind: 'message',
          })
          if (!posted.posted) return { sent: false, reason: posted.reason }
          return {
            sent: true,
            to: posted.to,
            note: `${posted.to} will see this next time they are working — a message, not a job, and no email needed. Delegate it if you need them to do something.`,
          }
        }
        return send(to, subject, body, attachFileIds)
      },
    }),
  ]
}

/**
 * Ask a person a question and genuinely wait for the answer. The email goes
 * out immediately (a new thread, so the answer routes back unambiguously);
 * the run then suspends — its transcript is kept — and resumes the moment a
 * reply lands on that thread. Silence gets one nudge, then the agent is woken
 * to decide. This is the colleague move: never fail quietly when a person
 * could unblock you.
 */
export function askAbilities(args: {
  tenantId: string
  person: PersonRow
  runId: string
  /**
   * The human ask this run descends from, so anything handed to a colleague
   * carries it too and the cost of one request stays totalled in one place.
   */
  rootRunId?: string
  waitState: GovernanceState
}): Ability[] {
  const { tenantId, person, runId, waitState } = args
  const rootRunId = args.rootRunId
  return [
    defineAbility({
      name: 'ask_and_wait',
      description:
        'Email someone a question and pause this task until they answer. Use it when the work is blocked on information only a person has — a colleague, the customer, a vendor. The task resumes automatically when the reply arrives; after days of silence you nudge once, then get woken to decide. Ask one clear, answerable question. (Not for replying on the thread you are already handling — use reply_to_thread for that.)',
      category: null,
      inputSchema: z.object({
        to: z.string().describe('The email address of the person who has the answer'),
        subject: z.string(),
        question: z.string().describe('The full email body: context plus the specific question. Sign it as yourself.'),
        nudgeAfterDays: z
          .number()
          .int()
          .min(1)
          .max(14)
          .default(3)
          .describe('Days of silence before your one follow-up nudge.'),
      }),
      execute: async ({ to, subject, question, nudgeAfterDays }) => {
        const colleague = await findColleague(to)
        // Waiting days for an email is what you do for a person. An AI
        // colleague is reachable now and answers by coming back to you, so
        // suspending the run on a mail thread they were never going to read
        // just parked the work — and, with no mailbox on either side, parked
        // it forever.
        if (colleague?.kind === 'agent') {
          const posted = await postToColleague({
            tenantId,
            from: { id: person.id, name: person.name, title: person.title, email: person.email },
            toEmail: to,
            title: subject,
            body: question,
            runId,
            ...(rootRunId ? { rootRunId } : {}),
            // A question is a small job: somebody has to go and answer it.
            kind: 'work',
          })
          if (!posted.posted) return { sent: false, reason: posted.reason }
          return {
            sent: true,
            waiting: false,
            note: `${posted.to} has the question and comes back to you directly with the answer. Do not pause for it and do not schedule anything to check — finish what you can now, and their answer will start you up again when it lands.`,
          }
        }
        const { threadId } = await sendNewMail({
          tenantId,
          personId: person.id,
          to: [{ address: to }],
          subject,
          text: question,
          runId,
        })
        waitState.pendingWait = { threadId, to, question: subject, nudgeAfterDays }
        return {
          sent: true,
          waiting: true,
          note: `Question sent${colleague ? ' to a colleague' : ''}. This task now pauses until the reply arrives — wrap up your current turn; you will be resumed with the answer.`,
        }
      },
    }),
  ]
}

/**
 * Committing to a deliverable. Taking the assignment is ungoverned — it is a
 * promise, not an action; the work it triggers runs under the full dial
 * (documents are file_write, delivery is external_email) in its own background
 * run, which starts within moments and survives the current conversation.
 */
export function assignmentAbilities(args: {
  tenantId: string
  person: PersonRow
  source: AssignmentSource
  /** Who the agent is talking to right now — the default recipient. */
  counterparty?: { name?: string; address?: string }
}): Ability[] {
  const app = db()
  const { tenantId, person, source, counterparty } = args
  return [
    defineAbility({
      name: 'take_assignment',
      description:
        'Commit to work that takes real time — anything a capable colleague could be asked to handle: research, a report or spreadsheet, contacting people, comparing options, drafting something, chasing an answer. Capture exactly what was asked (outcome, any file formats wanted, recipient, deadline), confirm it, then call this. The work starts immediately in the background and continues after this conversation ends; the outcome — and any files produced — is emailed to the recipient when done.',
      category: null,
      inputSchema: z.object({
        title: z.string().describe('Short name for the work, e.g. "Competitor pricing comparison"'),
        spec: z
          .string()
          .describe(
            'The full brief, written to your working self: what to do or produce, what a good outcome looks like, and anything agreed about scope or emphasis.',
          ),
        formats: z
          .array(z.enum(['pdf', 'docx', 'xlsx']))
          .optional()
          .describe('File format(s) explicitly asked for, if any. Omit when no file was requested — many assignments are answered in the email itself.'),
        deliverToEmail: z
          .string()
          .optional()
          .describe('Recipient email. Omit to deliver to the person you are talking with.'),
        deliverToName: z.string().optional(),
        dueAt: z.string().optional().describe('ISO 8601 deadline, if one was agreed.'),
      }),
      execute: async ({ title, spec, formats, deliverToEmail, deliverToName, dueAt }) => {
        const address = deliverToEmail ?? counterparty?.address
        if (!address) {
          return {
            taken: false,
            reason: 'No recipient: ask who should receive the deliverable and pass deliverToEmail.',
          }
        }
        const due = dueAt ? new Date(dueAt) : null
        if (due && Number.isNaN(due.getTime())) return { taken: false, reason: 'dueAt is not a valid date.' }
        const name = deliverToName ?? (deliverToEmail ? undefined : counterparty?.name)
        const [row] = await app.db
          .insert(assignments)
          .values({
            tenantId,
            personId: person.id,
            source,
            title,
            spec,
            formats: formats ?? [],
            deliverTo: { ...(name ? { name } : {}), address },
            dueAt: due,
            createdBy: person.id,
          })
          .returning({ id: assignments.id })
        return {
          taken: true,
          assignmentId: row!.id,
          note: `Work starts now in the background and will be emailed to ${address} when finished. You can wrap up the conversation.`,
        }
      },
    }),
  ]
}

/**
 * Text messaging — present only when the tenant has configured an SMS
 * provider. Governed under the telephony category: texting reaches the same
 * phones calls do.
 */
export async function smsAbilities(args: { tenantId: string }): Promise<Ability[]> {
  const { tenantId } = args
  if (!(await smsConfigured(tenantId))) return []
  return [
    defineAbility({
      name: 'send_sms',
      description:
        'Send a text message to a phone number (E.164, e.g. +15551234567). For short, timely notes — confirmations, reminders, "your order is ready". Anything longer belongs in email.',
      category: 'phone_call',
      inputSchema: z.object({
        to: z.string().describe('Destination number in E.164 format'),
        body: z.string().max(640).describe('The message. Short and clear; sign with your first name if signing.'),
      }),
      execute: async ({ to, body }) => {
        await sendSms({ tenantId, to, body })
        return { sent: true, to }
      },
    }),
  ]
}

/**
 * Delegation between agents: hand a colleague a real assignment with the
 * result returned to you by email — which restarts your involvement as an
 * ordinary inbound run, so review-then-forward is natural. Governed as
 * internal_email: it creates work and mail inside the company.
 */
export function delegationAbilities(args: {
  tenantId: string
  person: PersonRow
  runId: string
  /** The human ask this descends from — carried onto the work handed over. */
  rootRunId?: string
  /**
   * How far this work already is from the person who asked. Passing it on
   * increments it; without it every handoff claimed to be the first and the
   * depth guard never fired.
   */
  handoffDepth?: number
}): Ability[] {
  const { tenantId, person, runId } = args
  const rootRunId = args.rootRunId
  return [
    defineAbility({
      name: 'delegate_to_colleague',
      description:
        'Hand a piece of work to an AI colleague from the directory (delegate down or sideways — humans you simply email). They work it as their own assignment and email you the outcome, which you should review before passing it on. Give a complete brief; they know nothing about your current task except what you write here.',
      category: 'internal_email',
      inputSchema: z.object({
        toEmail: z.string().describe('The AI colleague’s directory email address'),
        title: z.string(),
        brief: z
          .string()
          .describe('The full self-contained brief: goal, context they need, what a good outcome looks like.'),
        formats: z.array(z.enum(['pdf', 'docx', 'xlsx'])).optional().describe('File formats, only if files are needed.'),
        dueAt: z.string().optional().describe('ISO 8601 deadline, if there is one.'),
      }),
      execute: async ({ toEmail, title, brief, formats, dueAt }) => {
        const due = dueAt ? new Date(dueAt) : null
        if (due && Number.isNaN(due.getTime())) return { delegated: false, reason: 'dueAt is not a valid date.' }
        // One path for every internal handoff, so the loop guard is one thing
        // and cannot be walked around by picking the other tool.
        const posted = await postToColleague({
          tenantId,
          from: { id: person.id, name: person.name, title: person.title, email: person.email },
          toEmail,
          title,
          body: brief,
          runId,
          ...(rootRunId ? { rootRunId } : {}),
          ...(args.handoffDepth ? { hops: args.handoffDepth } : {}),
          kind: 'work',
          ...(formats?.length ? { formats } : {}),
          ...(due ? { dueAt: due } : {}),
        })
        if (!posted.posted) return { delegated: false, reason: posted.reason }
        return {
          delegated: true,
          assignmentId: posted.assignmentId,
          note: `${posted.to} starts immediately and comes back to you directly with the outcome — no email in the way. You do not need to wait here, and you do not need to schedule anything to check on it.`,
        }
      },
    }),
  ]
}

/** Self-scheduling — gated on the proactivity dial at the assembly site. */
export function schedulingAbilities(args: { tenantId: string; person: PersonRow }): Ability[] {
  const app = db()
  const { tenantId, person } = args
  return [
    defineAbility({
      name: 'schedule_task',
      description:
        'Schedule work for your future self — once at a specific date and time, or on a repeating schedule. Use it for follow-ups ("chase this invoice on Friday") and reminders. A repeat you book for yourself is bounded and will not run for ever: if what you are waiting on has not moved after a few checks, that is not something to keep checking, it is something to tell a person about. Never schedule a repeat to poll for a colleague\'s answer — they come back to you on their own. Returns when it will first run.',
      category: null,
      inputSchema: z.object({
        title: z.string().describe('Short name, e.g. "Chase Acme invoice"'),
        instruction: z.string().describe('What to do when it runs, written to your future self.'),
        when: z.discriminatedUnion('kind', [
          z.object({
            kind: z.literal('once'),
            at: z.string().describe('ISO 8601 date-time, e.g. 2026-08-01T15:00:00Z'),
          }),
          z.object({
            kind: z.literal('cron'),
            pattern: z.string().describe('Five-field cron, e.g. "0 9 * * 1" for 9am every Monday'),
            timezone: z.string().optional().describe('IANA zone the pattern means, e.g. America/New_York'),
          }),
        ]),
        endsAt: z.string().optional().describe('ISO 8601; a repeating task stops after this.'),
        maxRuns: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            `How many times a repeating task may fire. Defaults to ${MAX_SELF_SCHEDULED_REPEATS} and cannot exceed it — say how many times this is genuinely worth checking.`,
          ),
      }),
      execute: async ({ title, instruction, when, endsAt, maxRuns }) => {
        const open = await app.db
          .select({ id: duties.id })
          .from(duties)
          .where(and(eq(duties.personId, person.id), eq(duties.enabled, 'on')))
        if (open.length >= MAX_SELF_SCHEDULED_DUTIES) {
          return {
            scheduled: false,
            reason: `You already have ${open.length} active scheduled tasks, which is the limit. Cancel one before booking another.`,
          }
        }

        const ends = endsAt ? new Date(endsAt) : null
        if (ends && Number.isNaN(ends.getTime())) return { scheduled: false, reason: 'endsAt is not a valid date.' }

        const spec =
          when.kind === 'once'
            ? { scheduleKind: 'once' as const, schedule: when.at, timezone: null, startsAt: null, endsAt: ends }
            : {
                scheduleKind: 'cron' as const,
                schedule: when.pattern,
                timezone: when.timezone ?? person.timezone ?? null,
                startsAt: null,
                endsAt: ends,
              }

        let nextDueAt: Date | null
        try {
          nextDueAt = firstOccurrence(spec)
        } catch (error) {
          return { scheduled: false, reason: (error as Error).message }
        }
        if (!nextDueAt) return { scheduled: false, reason: 'That schedule has no upcoming run.' }
        if (nextDueAt.getTime() <= Date.now()) {
          return { scheduled: false, reason: 'That time has already passed — pick a future one.' }
        }
        const gap = gapMinutes(spec)
        if (gap < MIN_SELF_SCHEDULE_GAP_MINUTES) {
          return {
            scheduled: false,
            reason: `That repeats every ${Math.round(gap)} minutes; the closest you can schedule yourself is every ${MIN_SELF_SCHEDULE_GAP_MINUTES}.`,
          }
        }

        const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'task'
        const taken = new Set(
          (await app.db.select({ slug: duties.slug }).from(duties).where(eq(duties.personId, person.id))).map(
            (d) => d.slug,
          ),
        )
        let slug = base
        for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`

        await app.db.insert(duties).values({
          tenantId,
          personId: person.id,
          slug,
          title,
          instruction,
          ...spec,
          // Bounded whatever the model said, including when it said nothing.
          maxRuns:
            when.kind === 'once' ? null : Math.min(maxRuns ?? MAX_SELF_SCHEDULED_REPEATS, MAX_SELF_SCHEDULED_REPEATS),
          nextDueAt,
          // Audit provenance: this duty was booked by the agent, not an operator.
          createdBy: person.id,
        })
        const cap = when.kind === 'once' ? null : Math.min(maxRuns ?? MAX_SELF_SCHEDULED_REPEATS, MAX_SELF_SCHEDULED_REPEATS)
        return {
          scheduled: true,
          slug,
          firstRunAt: nextDueAt.toISOString(),
          ...(cap
            ? {
                runsAtMost: cap,
                note: `This repeats at most ${cap} times and then stops on its own. If what you are waiting on still has not happened by then, tell a person rather than booking it again.`,
              }
            : {}),
        }
      },
    }),
    defineAbility({
      name: 'list_scheduled_tasks',
      description: 'List the tasks you have scheduled for yourself, with their schedules and next run times.',
      category: null,
      inputSchema: z.object({}),
      execute: async () => {
        const mine = await app.db
          .select()
          .from(duties)
          .where(eq(duties.personId, person.id))
          .orderBy(duties.nextDueAt)
        return {
          tasks: mine.map((d) => ({
            slug: d.slug,
            title: d.title,
            kind: d.scheduleKind,
            schedule: d.schedule,
            timezone: d.timezone,
            active: d.enabled === 'on',
            nextRunAt: d.nextDueAt?.toISOString() ?? null,
            runsSoFar: d.runCount,
          })),
        }
      },
    }),
    defineAbility({
      name: 'cancel_scheduled_task',
      description: 'Cancel a task you scheduled for yourself, by its slug from list_scheduled_tasks.',
      category: null,
      inputSchema: z.object({ slug: z.string() }),
      execute: async ({ slug }) => {
        const [gone] = await app.db
          .delete(duties)
          .where(and(eq(duties.personId, person.id), eq(duties.slug, slug)))
          .returning({ title: duties.title })
        return gone ? { cancelled: true, title: gone.title } : { cancelled: false, reason: 'No such task.' }
      },
    }),
  ]
}

// ---------------------------------------------------------------------------
// MCP integrations — tenant-configured external systems
// ---------------------------------------------------------------------------

/**
 * Connect the tenant's MCP integrations and return their abilities. A server
 * that fails to connect is reported, not fatal — the agent works with what is
 * reachable and says so.
 */
/**
 * The credentials one saved system is reached with, whichever way it was
 * connected. OAuth grants mint a fresh access token per connection; pasted
 * headers are unsealed. Shared so that what an operator is shown on screen is
 * fetched over exactly the connection an agent would use, not an approximation
 * of it.
 */
export async function resolveIntegrationHeaders(
  tenantId: string,
  entry: McpIntegrationEntry,
): Promise<Record<string, string> | undefined> {
  // Before the OAuth grant: a connection that holds a certificate authenticates
  // as itself, and never falls back to a stored token set even if an older
  // sign-in left one behind.
  if (entry.m2m) return mcpM2mHeaders(tenantId, entry)
  if (entry.oauth) return mcpOauthHeaders(tenantId, entry)
  if (entry.sealedHeaders) {
    const raw = unsealSecret(entry.sealedHeaders)
    if (!raw) throw new Error('its credentials could not be unsealed — reconnect it under Resources → Systems.')
    return JSON.parse(raw) as Record<string, string>
  }
  return undefined
}

export async function connectIntegrationAbilities(
  tenantId: string,
  agent: AgentBinding,
): Promise<{
  abilities: Ability[]
  failures: string[]
  secrets: string[]
  close: () => Promise<void>
}> {
  // Only the systems this agent has been given. A connection nobody assigned to
  // it is not connected at all — an agent should no more carry the accounting
  // package's tools it was never granted than a person should hold the login.
  const entries = (await listMcpIntegrations(tenantId)).filter((entry) => bindsToAgent(entry.assignment, agent))
  const abilities: Ability[] = []
  const failures: string[] = []
  const secrets: string[] = []
  const closers: (() => Promise<void>)[] = []
  for (const entry of entries) {
    try {
      const headers = await resolveIntegrationHeaders(tenantId, entry)
      for (const value of Object.values(headers ?? {})) {
        if (!value.trim()) continue
        secrets.push(value)
        const credential = value.match(/^\S+\s+(.+)$/)?.[1]?.trim()
        if (credential) secrets.push(credential)
      }
      const connection = await connectMcpServers([
        {
          slug: entry.slug,
          url: entry.url,
          category: entry.category as ActionCategory,
          ...(headers ? { headers } : {}),
        },
      ])
      abilities.push(...connection.abilities)
      closers.push(connection.close)
    } catch (error) {
      failures.push(`${entry.label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    abilities,
    failures,
    secrets,
    close: async () => {
      await Promise.allSettled(closers.map((close) => close()))
    },
  }
}

/**
 * Everything an agent can do, assembled for one run or call. `reply_to_thread`
 * stays with the email loop — it is bound to a live thread, not a capability.
 */
export async function assembleAbilities(args: {
  tenantId: string
  person: PersonRow
  runId: string
  /** Where this run's commitments would anchor (a call, a thread, an operator). */
  assignmentSource?: AssignmentSource
  /** Who the agent is talking to, when known — the default deliverable recipient. */
  counterparty?: { name?: string; address?: string }
  /**
   * Shared loop state for suspending runs. Async runs pass it and gain
   * ask_and_wait; live calls omit it (a call cannot pause on an email).
   */
  waitState?: GovernanceState
  /**
   * The human ask this run descends from. Carried onto everything handed to a
   * colleague, so what one request cost stays totalled in one place however
   * far the work spreads.
   */
  rootRunId?: string
  /** How many colleagues this work has already passed between before now. */
  handoffDepth?: number
}): Promise<{
  abilities: Ability[]
  integrationFailures: string[]
  secrets: string[]
  close: () => Promise<void>
}> {
  const { tenantId, person, runId } = args
  const integrations = await connectIntegrationAbilities(tenantId, agentBinding(person))
  // Who counts as a colleague, read once. Mail to one of these is internal
  // whichever tool sends it — see the category resolver in emailAbilities.
  const isInternalAddress = await loadInternalAddressTest(tenantId)
  // The desk feature gate, resolved once from the single source of truth
  // (desk-policy.ts). `desk` gates the machine; `desktop` — never available
  // without its parent — gates the screen. The runner being configured is
  // still required on top: a switched-on feature with no runner fails closed.
  const deskFeatures = await resolveDeskFeatures(tenantId)
  const abilities: Ability[] = [
    ...memoryAbilities({ tenantId, person, runId }),
    ...researchAbilities({ tenantId }),
    ...emailAbilities({ tenantId, person, runId, isInternalAddress, ...(args.rootRunId ? { rootRunId: args.rootRunId } : {}) }),
    ...(args.waitState
      ? askAbilities({ tenantId, person, runId, waitState: args.waitState, ...(args.rootRunId ? { rootRunId: args.rootRunId } : {}) })
      : []),
    ...(await smsAbilities({ tenantId })),
    ...(await chatAbilities({ tenantId, person, runId })),
    ...outboundCallAbilities({ tenantId, person, runId }),
    ...meetingAbilities({ tenantId, person, runId }),
    ...delegationAbilities({
      tenantId,
      person,
      runId,
      ...(args.rootRunId ? { rootRunId: args.rootRunId } : {}),
      ...(args.handoffDepth ? { handoffDepth: args.handoffDepth } : {}),
    }),
    ...documentAbilities({ tenantId, person, runId }),
    ...templateAbilities({ tenantId, person, runId }),
    ...workspaceAbilities(),
    // The desk: run_shell, the workspace files, the screen. Fails closed
    // without a runner; the desktop family additionally rides the desktop
    // feature inside deskAbilities.
    ...deskAbilities({ tenantId, person, runId, features: deskFeatures }),
    ...(deskFeatures.desk ? toolAbilities({ tenantId, person, runId }) : []),
    // The browser lives in the desk (tier 1 — no screen needed), so it needs
    // the machine, not the desktop feature.
    ...(deskSupported() && deskFeatures.desk ? browserAbilities({ tenantId, person, runId }) : []),
    ...assignmentAbilities({
      tenantId,
      person,
      source: args.assignmentSource ?? { kind: 'manual' },
      ...(args.counterparty ? { counterparty: args.counterparty } : {}),
    }),
    // Self-scheduling follows the proactivity dial: an agent set to react only
    // answers what reaches it, and has no business booking its own future work.
    ...((person.proactivity ?? 'duties') !== 'reactive' ? schedulingAbilities({ tenantId, person }) : []),
    ...integrations.abilities,
  ]
  return {
    abilities,
    integrationFailures: integrations.failures,
    secrets: integrations.secrets,
    close: integrations.close,
  }
}
