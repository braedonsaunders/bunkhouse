import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { unsealSecret } from '@braedonsaunders/appkit-crypto'
import { auditLog } from '@braedonsaunders/appkit-db'
import {
  connectMcpServers,
  defineAbility,
  httpSystemDefinitionSchema,
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
import { authoredSystemAbilities, listAuthoredSystems, proposeAuthoredSystem } from './authored-systems'
import { requestSystemCredential } from './system-credential-requests'
import { sendNewMail } from './mailbox'
import { createNote, retrieveNotes, supersedeNote } from './memory'
import { firstOccurrence, gapMinutes, MAX_SELF_SCHEDULED_REPEATS, scheduledRunLimit } from './duties'
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
import { closeRemoteWork, controlRemoteComputer, listRemoteComputers, openRemoteWork, runRemoteCommand } from './remote-computers'

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

function remoteComputerAbilities(args: { tenantId: string; person: PersonRow; runId: string }): Ability[] {
  const { tenantId, person, runId } = args
  return [
    defineAbility({
      name: 'list_remote_computers',
      description: 'List the customer-owned computers you may work on. These are separate from your Bunkhouse desk and remain visible to the human in the conversation while you use their terminal or screen.',
      category: null,
      inputSchema: z.object({}),
      execute: async () => ({
        computers: (await listRemoteComputers(tenantId))
          .filter((computer) => computer.status !== 'disabled')
          .map((computer) => ({ id: computer.id, name: computer.name, protocol: computer.protocol, status: computer.status })),
      }),
    }),
    defineAbility({
      name: 'open_remote_computer',
      description: 'Open a durable session on a customer-owned computer. Use computer for its graphical screen or terminal for direct SSH/PowerShell/WinRM work. A reasonable direct request from your manager is a valid work reason when the autonomy gate permits it; do not reject it merely because it is outside your usual duties.',
      category: (input) => (typeof input === 'object' && input !== null && (input as { kind?: unknown }).kind === 'terminal' ? 'sandbox' : 'desktop'),
      approval: 'each-call',
      inputSchema: z.object({ computerId: z.string().uuid(), kind: z.enum(['computer', 'terminal']).default('computer') }),
      execute: async ({ computerId, kind }) => {
        const session = await openRemoteWork({ tenantId, computerId, personId: person.id, runId, kind })
        return { sessionId: session.id, computerId, kind, protocol: session.protocol, status: session.status, note: 'The session stays open while idle; close it when the work or handover is genuinely finished.' }
      },
    }),
    defineAbility({
      name: 'remote_command',
      description: 'Drive an open customer computer directly through its remote terminal. Prefer this for repository, file, process, and development work even while its graphical desktop remains open; do not type commands into a visible terminal just to make them observable.',
      category: 'sandbox',
      approval: 'continues',
      inputSchema: z.object({ sessionId: z.string().uuid(), command: z.string().min(1), cwd: z.string().optional() }),
      execute: async ({ sessionId, command, cwd }) => runRemoteCommand({ tenantId, sessionId, command, ...(cwd ? { cwd } : {}) }),
    }),
    defineAbility({
      name: 'remote_desktop_action',
      description: 'Operate an open RDP or VNC computer programmatically while the human watches the same computer in chat. Each action returns the resulting screen. Use snapshot first, then click, type, key, drag, or scroll using screen coordinates.',
      category: 'desktop',
      approval: 'continues',
      inputSchema: z.object({
        sessionId: z.string().uuid(),
        action: z.discriminatedUnion('action', [
          z.object({ action: z.literal('snapshot'), label: z.string().optional() }),
          z.object({ action: z.enum(['click', 'double_click']), x: z.number(), y: z.number(), label: z.string().optional() }),
          z.object({ action: z.literal('drag'), fromX: z.number(), fromY: z.number(), toX: z.number(), toY: z.number(), durationMs: z.number().optional(), label: z.string().optional() }),
          z.object({ action: z.literal('scroll'), x: z.number(), y: z.number(), direction: z.enum(['up', 'down']), amount: z.number().optional(), label: z.string().optional() }),
          z.object({ action: z.literal('type'), text: z.string(), label: z.string().optional() }),
          z.object({ action: z.literal('key'), key: z.string(), label: z.string().optional() }),
          z.object({ action: z.literal('wait'), durationMs: z.number().optional(), label: z.string().optional() }),
        ]),
      }),
      execute: async ({ sessionId, action }) => {
        const controlled = await controlRemoteComputer({ tenantId, sessionId, action })
        return {
          actionId: controlled.actionId,
          ok: controlled.result.ok,
          ...(controlled.result.message ? { message: controlled.result.message } : {}),
          ...(controlled.result.frame ? { screenshot: { mediaType: controlled.result.frame.mimeType, data: controlled.result.frame.data, label: `Remote computer after ${action.action}` } } : {}),
        }
      },
    }),
    defineAbility({
      name: 'close_remote_computer',
      description: 'Close a customer-computer session after the task or an operator handover is finished. Do not close it just because you are idle between steps.',
      category: 'desktop',
      approval: 'continues',
      inputSchema: z.object({ sessionId: z.string().uuid() }),
      execute: async ({ sessionId }) => {
        await closeRemoteWork({ tenantId, sessionId, reason: 'completed' })
        return { closed: true, sessionId }
      },
    }),
  ]
}

/** The logbook: save and search notes. Ungoverned — it is the agent's own head. */
export function memoryAbilities(args: { tenantId: string; person: PersonRow; runId: string }): Ability[] {
  const app = db()
  const { tenantId, person, runId } = args
  return [
    defineAbility({
      name: 'save_memory',
      description:
        'Save durable knowledge to your logbook only when it will materially help a future run and is not already present in the run, mail, desk, or tool ledger. Never save routine operational receipts such as opening or closing the desktop, taking screenshots, running commands, calling tools, or merely completing the current task; those are already recorded and would crowd out useful knowledge. Save stable business facts, reusable procedures, consequential outcomes, and evidence-backed reflections. If a live note with the same title exists, yours supersedes it (the old one is kept in history). Use [[wikilinks]] to connect notes.',
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
        'Fetch a public web page and return its readable text content. Quick and unseen — it is a fetch, not a visit, so nothing appears in chat or on a caller\'s screen and pages that need a click, a sign-in, or JavaScript come back empty or wrong. Never use this as a substitute when the person asked you to open, pull up, show, or navigate to a page: use browser_open, and if that fails say the visible browser failed instead of claiming this fetch opened it.',
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
      name: 'start_subagent',
      description:
        'Launch a piece of your own work to run beside you, and keep going. Use it when a task splits into parts that do not depend on each other — read nine filings while you read the tenth, check six tickers at once. Launch them all first, then call await_launched_work; launching one and waiting for it is slower than just doing it yourself. Each one runs as you, with your tools and your budget, and knows only the brief you write here.',
      // Doing your own work in parallel is not a new actor and grants nothing
      // the agent did not already have — the child inherits this person's dials
      // and this person's budget, and every governed action inside it is gated
      // exactly as it would be inline.
      category: null,
      inputSchema: z.object({
        label: z.string().min(1).max(80).describe('A short name, so you can tell them apart when you collect them.'),
        brief: z
          .string()
          .min(1)
          .max(20_000)
          .describe('The complete self-contained instruction. It sees none of your context except this.'),
      }),
      execute: async ({ label, brief }) => {
        const { createChildRun, childrenOf, childDepth, MAX_CHILDREN_PER_RUN, MAX_CHILD_DEPTH } =
          await import('./subagents')
        const depth = await childDepth(tenantId, runId)
        if (depth >= MAX_CHILD_DEPTH) {
          return { started: false, reason: `This work is already ${depth} levels deep. Do this part yourself.` }
        }
        const existing = await childrenOf(tenantId, runId)
        if (existing.length >= MAX_CHILDREN_PER_RUN) {
          return {
            started: false,
            reason: `You have already launched ${existing.length}. Collect them before launching more.`,
          }
        }
        const id = await createChildRun({
          tenantId,
          personId: person.id,
          parentRunId: runId,
          rootRunId: rootRunId ?? runId,
          label,
          brief,
          kind: 'subagent',
          byPersonId: person.id,
        })
        return {
          started: true,
          subagentId: id,
          label,
          note: 'Running beside you. Launch the rest now; collect them all with await_launched_work.',
        }
      },
    }),
    defineAbility({
      name: 'invoke_report',
      description:
        'Put a named AI employee who reports to you — directly or further down — straight onto a piece of work, and collect their answer yourself. Unlike delegate_to_colleague, which hands work away as an assignment and gets an email back later, this runs now and returns to you. They work under their own permissions and their own budget, with their own tools, so use this when the work genuinely needs who they are rather than just another pair of hands. Peers and managers cannot be invoked: email a peer, escalate to a manager.',
      // The invoked person's OWN dials govern everything inside their run, so
      // this grants the caller nothing it could not already ask for by email.
      // What it does spend is the report's budget, which is why it is bounded
      // to people beneath the caller in the tree.
      category: null,
      inputSchema: z.object({
        toEmail: z.string().min(1).max(200).describe('The directory email of the employee who reports to you.'),
        label: z.string().min(1).max(80).describe('A short name for the piece of work.'),
        brief: z
          .string()
          .min(1)
          .max(20_000)
          .describe('The complete self-contained brief. They know nothing of your task except this.'),
      }),
      execute: async ({ toEmail, label, brief }) => {
        const { canInvoke, createChildRun, childrenOf, childDepth, orgRoster, MAX_CHILDREN_PER_RUN, MAX_CHILD_DEPTH } =
          await import('./subagents')
        const roster = await orgRoster(tenantId)
        const wanted = toEmail.trim().toLowerCase()
        const target = roster.find((candidate) => (candidate.email ?? '').toLowerCase() === wanted)
        if (!target) return { started: false, reason: `No employee in the directory has the address ${toEmail}.` }
        if (target.kind !== 'agent') {
          return { started: false, reason: `${target.name} is a person, not an AI employee. Email them instead.` }
        }
        if (!canInvoke(roster, person.id, target.id)) {
          return {
            started: false,
            reason:
              `${target.name} does not report to you, so you cannot put them straight onto work. `
              + 'Use delegate_to_colleague to ask, or email them.',
          }
        }
        const depth = await childDepth(tenantId, runId)
        if (depth >= MAX_CHILD_DEPTH) {
          return { started: false, reason: `This work is already ${depth} levels deep. Do this part yourself.` }
        }
        const existing = await childrenOf(tenantId, runId)
        if (existing.length >= MAX_CHILDREN_PER_RUN) {
          return { started: false, reason: `You have already launched ${existing.length}. Collect them first.` }
        }
        const id = await createChildRun({
          tenantId,
          personId: target.id,
          parentRunId: runId,
          rootRunId: rootRunId ?? runId,
          label,
          brief,
          kind: 'invocation',
          byPersonId: person.id,
        })
        return {
          started: true,
          subagentId: id,
          label,
          who: target.name,
          note: `${target.name} is on it. Collect with await_launched_work.`,
        }
      },
    }),
    defineAbility({
      name: 'await_launched_work',
      description:
        'Collect everything you launched with start_subagent or invoke_report. Waits until they finish, then hands you their answers. Call it ONCE after launching everything — it returns whatever is done when the wait runs out, and you can call it again for the rest.',
      category: null,
      inputSchema: z.object({
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(600)
          .default(240)
          .describe('How long to wait for the outstanding ones. Use 0 to look without waiting.'),
      }),
      execute: async ({ waitSeconds }) => {
        const { childrenOf, childIsFinished } = await import('./subagents')
        const deadline = Date.now() + waitSeconds * 1_000
        let children = await childrenOf(tenantId, runId)
        if (children.length === 0) return { launched: 0, note: 'You have not launched anything on this run.' }
        // Poll rather than subscribe: a child is a whole run in another
        // process, and the thing being waited on is minutes long, so a few
        // seconds of latency costs nothing and needs no notification channel.
        while (Date.now() < deadline && children.some((child) => !childIsFinished(child.status))) {
          await new Promise((resolve) => setTimeout(resolve, 3_000))
          children = await childrenOf(tenantId, runId)
        }
        const finished = children.filter((child) => childIsFinished(child.status))
        const pending = children.filter((child) => !childIsFinished(child.status))
        return {
          results: finished.map((child) => ({
            label: child.label,
            who: child.personName,
            status: child.status,
            // A failed child's summary is its error; either way it is what
            // came back, and the parent decides what that is worth.
            answer: child.summary ?? (child.status === 'completed' ? '(no answer recorded)' : '(did not finish)'),
          })),
          ...(pending.length > 0
            ? {
                stillRunning: pending.map((child) => child.label),
                note: `${pending.length} still working. Call await_launched_work again for those.`,
              }
            : {}),
        }
      },
    }),
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
        // "Down or sideways" was, until now, only a sentence in the description
        // — nothing stopped an agent assigning work to its own manager, which
        // inverts the reporting line every other surface reads as authority.
        // Enforced here rather than in the prompt, because a rule a model is
        // merely asked to follow is a rule that holds until it is inconvenient.
        const { orgRoster } = await import('./subagents')
        const { managerChain } = await import('./org')
        const roster = await orgRoster(tenantId)
        const wanted = toEmail.trim().toLowerCase()
        const target = roster.find((candidate) => (candidate.email ?? '').toLowerCase() === wanted)
        if (target && managerChain(roster, person.id).some((manager) => manager.id === target.id)) {
          return {
            delegated: false,
            reason:
              `${target.name} is above you in the reporting line — you cannot assign work upward. `
              + 'Escalate by emailing them instead.',
          }
        }
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
export function schedulingAbilities(args: {
  tenantId: string
  person: PersonRow
  runId: string
  allowStandingSchedules?: boolean
}): Ability[] {
  const app = db()
  const { tenantId, person, runId } = args
  return [
    defineAbility({
      name: 'schedule_task',
      description:
        'Create a durable scheduled duty from this conversation — once at a specific time or on a repeating schedule. When a person explicitly asks for an ongoing routine such as "every morning", set standing=true; it continues until they cancel it. Follow-ups you decide to book yourself must keep standing false and are bounded. Never create a standing routine unless the person actually requested it, and never poll for a colleague\'s answer — colleagues return on their own. Returns the first run time and whether the duty is ongoing.',
      category: 'background_job',
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
        standing: z
          .boolean()
          .optional()
          .describe('True only for an ongoing routine the person explicitly requested in this conversation.'),
        maxRuns: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            `How many times a repeating task may fire. Defaults to ${MAX_SELF_SCHEDULED_REPEATS} and cannot exceed it — say how many times this is genuinely worth checking.`,
          ),
      }),
      execute: async ({ title, instruction, when, endsAt, standing, maxRuns }) => {
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

        let runLimit: number | null
        try {
          runLimit = scheduledRunLimit({
            kind: when.kind,
            standing: standing === true,
            standingAllowed: args.allowStandingSchedules === true,
            ...(maxRuns === undefined ? {} : { maxRuns }),
          })
        } catch (error) {
          return { scheduled: false, reason: (error as Error).message }
        }

        const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'task'
        const taken = new Set(
          (await app.db.select({ slug: duties.slug }).from(duties).where(eq(duties.personId, person.id))).map(
            (d) => d.slug,
          ),
        )
        let slug = base
        for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`

        const created = await app.db.transaction(async (tx) => {
          const [duty] = await tx
            .insert(duties)
            .values({
              tenantId,
              personId: person.id,
              slug,
              title,
              instruction,
              ...spec,
              maxRuns: runLimit,
              nextDueAt,
              createdBy: person.id,
              sourceRunId: runId,
            })
            .returning({ id: duties.id })
          if (!duty) throw new Error('The scheduled task could not be saved.')
          await tx.insert(auditLog).values({
            tenantId,
            entityType: 'duty',
            entityId: duty.id,
            action: 'created_by_employee',
            summary: `${person.name} scheduled ${title}`,
            after: {
              personId: person.id,
              slug,
              scheduleKind: spec.scheduleKind,
              schedule: spec.schedule,
              timezone: spec.timezone,
              nextDueAt: nextDueAt.toISOString(),
              maxRuns: runLimit,
            },
            metadata: { personId: person.id, runId, standing: standing === true },
          })
          return duty
        })
        return {
          scheduled: true,
          dutyId: created.id,
          slug,
          firstRunAt: nextDueAt.toISOString(),
          ongoing: when.kind === 'cron' && runLimit === null,
          ...(runLimit
            ? {
                runsAtMost: runLimit,
                note: `This repeats at most ${runLimit} times and then stops on its own. If what you are waiting on still has not happened by then, tell a person rather than booking it again.`,
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
      category: 'background_job',
      inputSchema: z.object({ slug: z.string() }),
      execute: async ({ slug }) => {
        const cancelled = await app.db.transaction(async (tx) => {
          const [before] = await tx
            .select()
            .from(duties)
            .where(and(eq(duties.personId, person.id), eq(duties.slug, slug)))
          if (!before) return null
          await tx
            .update(duties)
            .set({ enabled: 'off', nextDueAt: null, updatedAt: new Date(), updatedBy: person.id })
            .where(eq(duties.id, before.id))
          await tx.insert(auditLog).values({
            tenantId,
            entityType: 'duty',
            entityId: before.id,
            action: 'cancelled_by_employee',
            summary: `${person.name} cancelled ${before.title}`,
            before: { enabled: before.enabled, nextDueAt: before.nextDueAt?.toISOString() ?? null },
            after: { enabled: 'off', nextDueAt: null },
            metadata: { personId: person.id, runId },
          })
          return before
        })
        return cancelled ? { cancelled: true, title: cancelled.title } : { cancelled: false, reason: 'No such task.' }
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
  const authored = (await listAuthoredSystems(tenantId)).filter((record) =>
    bindsToAgent(record.system.assignment, agent),
  )
  for (const record of authored) {
    try {
      const connected = authoredSystemAbilities(record)
      abilities.push(...connected.abilities)
      secrets.push(...connected.secrets)
    } catch (error) {
      failures.push(`${record.system.name}: ${error instanceof Error ? error.message : String(error)}`)
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
 * Draft a constrained company-private integration after researching a system.
 * A draft grants no access and executes nothing; an operator still supplies
 * the credential, reviews the proposed tools, tests the connection, and
 * activates the immutable version from Resources → Systems.
 */
function systemAuthoringAbilities(args: {
  tenantId: string
  person: PersonRow
  runId: string
  chatThreadId?: string
  waitState?: GovernanceState
}): Ability[] {
  return [
    defineAbility({
      name: 'propose_system_integration',
      description:
        'Propose a company-private system integration after reading the provider’s official API documentation. Define only the operations needed for the work, use an HTTPS base URL, classify every operation under its real autonomy category, and choose a harmless GET operation as the health check. Never put credentials, tokens, customer data, or example secrets in the definition. This creates a proposal only; a human reviews, authenticates, tests, and activates it in Resources → Systems.',
      category: 'record_write',
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        slug: z.string().min(1).max(64),
        description: z.string().min(1).max(2_000),
        definition: httpSystemDefinitionSchema,
        changeNote: z.string().max(1_000).optional(),
      }),
      execute: async ({ name, slug, description, definition, changeNote }) => {
        const proposed = await proposeAuthoredSystem({
          tenantId: args.tenantId,
          personId: args.person.id,
          runId: args.runId,
          name,
          slug,
          description,
          definition,
          ...(changeNote ? { changeNote } : {}),
        })
        return {
          proposed: true,
          system: proposed.slug,
          version: proposed.version,
          note: args.chatThreadId && definition.auth.kind !== 'none'
            ? 'The proposal is saved. Use request_system_credential next to show the operator a secure inline credential form; never ask them to paste a secret into chat.'
            : 'The proposal is visible in Resources → Systems. It cannot run until an operator reviews its abilities, supplies the credential if required, tests it, and activates it.',
        }
      },
    }),
    ...(args.chatThreadId ? [defineAbility({
      name: 'post_to_conversation',
      description:
        'Say something in the conversation this work belongs to, without being asked first. This is how scheduled and background work gets delivered: when you finish a standing deliverable, POST THE DELIVERABLE ITSELF here — the actual brief, the actual numbers — not a note saying it is ready somewhere. Nobody is watching a run summary at half past eight in the morning. Use it when you have something the person genuinely needs; a conversation is not a log, and narrating your progress into it is noise.',
      // Deliberately ungoverned. Writing into the reader's own conversation is
      // not an outward-facing act — it reaches nobody but the person who asked
      // for the work — and dialling it would let a scheduled delivery park on
      // an approval at 08:30 that nobody is awake to give, which recreates the
      // exact silence this ability exists to end.
      category: null,
      inputSchema: z.object({
        message: z
          .string()
          .min(1)
          .max(20_000)
          .describe('What to say, in full. Markdown renders. Put the deliverable here rather than describing it.'),
      }),
      execute: async ({ message }) => {
        const body = message.trim()
        if (!body) return { error: 'There is nothing to post — give the message some content.' }
        const { postAgentMessage } = await import('./chat-threads')
        const posted = await postAgentMessage({
          tenantId: args.tenantId,
          threadId: args.chatThreadId!,
          personId: args.person.id,
          runId: args.runId,
          body,
        })
        if (!posted) {
          return {
            error:
              'That conversation could not be posted into — it may have been deleted. '
              + 'The work stands; deliver it another way if it matters.',
          }
        }
        return {
          posted: true,
          note: 'It is in the conversation now. Do not repeat it in your final summary.',
        }
      },
    })] : []),
    ...(args.chatThreadId ? [defineAbility({
      name: 'request_system_credential',
      description:
        'Show the human a secure inline credential form for a system you proposed in this same run. Use this immediately after propose_system_integration when its auth kind requires a key or token. Explain exactly what the credential enables and link to the provider’s official credential page when known. The submitted value bypasses chat and model context, is tested server-side, and is stored encrypted. Never ask the human to paste a secret into a message or include a secret in any tool input.',
      // Showing a request grants nothing. The human's authenticated submit is
      // the gate that tests, seals, assigns and activates the integration.
      category: null,
      inputSchema: z.object({
        systemSlug: z.string().min(1).max(64),
        credentialLabel: z.string().min(1).max(120),
        purpose: z.string().min(1).max(500),
        helpUrl: z.string().url().startsWith('https://').optional(),
      }),
      execute: async ({ systemSlug, credentialLabel, purpose, helpUrl }) => {
        const requested = await requestSystemCredential({
          tenantId: args.tenantId,
          threadId: args.chatThreadId!,
          personId: args.person.id,
          runId: args.runId,
          systemSlug,
          credentialLabel,
          purpose,
          ...(helpUrl ? { helpUrl } : {}),
        })
        if (args.waitState) args.waitState.pendingCredentialRequestId = requested.id
        return {
          requestId: requested.id,
          status: requested.status,
          system: requested.systemName,
          note: 'The secure form is now in the conversation. The credential will not be included in the transcript or returned to you.',
        }
      },
    })] : []),
  ]
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
  /** A human is presently asking, so an explicit ongoing routine may be recorded. */
  allowStandingSchedules?: boolean
  /** The first-party web conversation that can render secure inline requests. */
  chatThreadId?: string
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
    ...systemAuthoringAbilities({
      tenantId,
      person,
      runId,
      ...(args.chatThreadId ? { chatThreadId: args.chatThreadId } : {}),
      ...(args.waitState ? { waitState: args.waitState } : {}),
    }),
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
    ...(deskFeatures.remoteComputers ? remoteComputerAbilities({ tenantId, person, runId }) : []),
    ...assignmentAbilities({
      tenantId,
      person,
      source: args.assignmentSource ?? { kind: 'manual' },
      ...(args.counterparty ? { counterparty: args.counterparty } : {}),
    }),
    // Self-scheduling follows the proactivity dial: an agent set to react only
    // answers what reaches it, and has no business booking its own future work.
    ...((person.proactivity ?? 'duties') !== 'reactive'
      ? schedulingAbilities({
          tenantId,
          person,
          runId,
          allowStandingSchedules: args.allowStandingSchedules,
        })
      : []),
    ...integrations.abilities,
  ]
  return {
    abilities,
    integrationFailures: integrations.failures,
    secrets: integrations.secrets,
    close: integrations.close,
  }
}
