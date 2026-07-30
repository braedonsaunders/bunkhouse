import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { assignments, people, type AssignmentSource } from '../db/schema'
import { db } from '../db/client'
import { createNote } from './memory'

/**
 * Handing something to a colleague inside the company, without email.
 *
 * Two agents at the same company had no way to give each other a piece of work
 * except by sending mail out through a provider and hoping it came back in.
 * Neither had a mailbox connected, so `email_colleague` threw "No mailbox
 * connected for this agent" on every attempt — and the agents, being diligent,
 * worked around it: they wrote their handoffs into their own logbooks addressed
 * "FOR: Bill McDonald, FROM: Jimmy Chonga", then scheduled themselves hourly
 * duties to go and check whether the other one had written back yet. Forty
 * fires overnight, each a full model run, polling for a message that could
 * never arrive. That is what the bill was.
 *
 * The mistake underneath it was treating an internal handoff as mail. Mail is
 * how you reach a person outside this system; a colleague inside it is reached
 * by giving them the work. That already exists and already runs without a
 * mailbox: an assignment, picked up by the background worker on the same
 * engine everything else uses. This module is that path, named.
 *
 * A human colleague still gets real email — people read their inbox, not our
 * assignments table — so this is for agents only, and the callers check.
 */

/** How many times a handoff may bounce between colleagues before it stops. */
const MAX_HOPS = 4

/**
 * How much work one agent may have outstanding before it must finish some.
 *
 * A backstop, not a policy. Four test phone calls produced 913 assignments in
 * an afternoon — the calls themselves cost twenty cents and the work the agents
 * generated for each other cost thirty-six dollars — because nothing bounded
 * how many pieces of work could exist at once. The hop counter bounds how DEEP
 * a chain goes; this bounds how WIDE the whole thing gets.
 */
const MAX_OUTSTANDING_PER_AGENT = 12

export type ColleaguePost =
  | { posted: true; assignmentId: string; to: string }
  /** Left for them to read, with no work started. */
  | { posted: true; assignmentId: null; to: string }
  | { posted: false; reason: string }

/** The other end of a handoff, resolved from a directory address. */
export async function findColleague(
  toEmail: string,
): Promise<{ id: string; name: string; email: string; kind: string } | null> {
  const app = db()
  const [row] = await app.db
    .select({ id: people.id, name: people.name, email: people.email, kind: people.kind })
    .from(people)
    .where(and(eq(people.status, 'active'), sql`lower(${people.email}) = ${toEmail.toLowerCase()}`))
  return row ?? null
}

/**
 * How far along a chain of handoffs this piece of work already is.
 *
 * A handoff that can start work on a colleague is a handoff that colleague can
 * return, and two agents being helpful at each other is a loop that spends real
 * money — the same shape as the one this module exists to end, just faster. The
 * count rides on the assignment's own source so it survives the run that
 * carried it, and the chain simply stops when it has gone on long enough.
 */
export function hopsOf(source: AssignmentSource | null | undefined): number {
  if (!source || source.kind !== 'delegation') return 0
  const hops = (source as { hops?: unknown }).hops
  return typeof hops === 'number' && Number.isFinite(hops) ? hops : 1
}

/**
 * Give a colleague something to do, or something they asked you for. Lands as
 * their own work, on the ordinary queue, with no mail anywhere in it.
 */
export async function postToColleague(args: {
  tenantId: string
  /** Who is handing it over. */
  from: { id: string; name: string; title: string; email: string }
  /** The colleague's directory address. */
  toEmail: string
  title: string
  /** The whole of it, in the sender's words — this becomes their brief. */
  body: string
  /** The run doing the handing over, for the audit trail. */
  runId: string
  /** Where this sits in a chain of handoffs; 0 when it starts one. */
  hops?: number
  /** True when this is the answer to something they handed over first. */
  returning?: boolean
  /**
   * 'message' is something to read; 'work' is something to do. Only work
   * starts a run, which is the difference between a colleague being told
   * something and a colleague being given a job.
   */
  kind: 'message' | 'work'
  /** When it was sent, for the note. Passed in rather than read from a clock. */
  sentAt: string
  /** File formats the work should produce, when it needs to produce files. */
  formats?: ('pdf' | 'docx' | 'xlsx')[]
  dueAt?: Date
}): Promise<ColleaguePost> {
  const app = db()
  const colleague = await findColleague(args.toEmail)
  if (!colleague) {
    return { posted: false, reason: `${args.toEmail} is not in the company directory.` }
  }
  if (colleague.id === args.from.id) return { posted: false, reason: 'That is you.' }
  if (colleague.kind !== 'agent') {
    return {
      posted: false,
      reason: `${colleague.name} is a person, and people read their email rather than a work queue — this one has to go by mail.`,
    }
  }
  // TELLING SOMEBODY SOMETHING IS NOT GIVING THEM A JOB.
  //
  // Every internal message became an assignment, and every assignment is a
  // full model run — so an agent saying "here is the list you asked for" spent
  // as much as an agent researching for an hour, and the reply spent it again.
  // That is where 913 assignments came from: work that begets work, with
  // nothing in between to say "this one is just a message".
  //
  // A person emailing a colleague does not start a background job in them.
  // They read it next time they are working. So a message lands in the
  // colleague's logbook, which is retrieved into their next run whatever
  // starts it — exactly what these agents invented for themselves when mail
  // was broken, addressed "FOR: Bill McDonald, FROM: Jimmy Chonga". They were
  // right. Only `delegate_to_colleague` hands over work that runs.
  if (args.kind === 'message') {
    await createNote({
      tenantId: args.tenantId,
      scope: 'agent',
      personId: colleague.id,
      kind: 'episode',
      title: `From ${args.from.name}: ${args.title}`.slice(0, 120),
      body: `${args.body}\n\n(Sent by ${args.from.name}, ${args.from.title}, on ${args.sentAt}. This is a message, not a job — act on it if it needs acting on, and reply only if there is something to say.)`,
      author: 'agent',
      importance: 4,
      sourceRunId: args.runId,
    })
    return { posted: true, assignmentId: null, to: colleague.name }
  }

  const hops = (args.hops ?? 0) + 1
  const outstanding = await app.db
    .select({ id: assignments.id })
    .from(assignments)
    .where(and(eq(assignments.personId, colleague.id), inArray(assignments.status, ['pending', 'working'])))
  if (outstanding.length >= MAX_OUTSTANDING_PER_AGENT) {
    return {
      posted: false,
      reason: `${colleague.name} already has ${outstanding.length} pieces of work outstanding, which is as many as anyone should be carrying. Say what you need in a message instead, or wait until they have finished something.`,
    }
  }
  if (hops > MAX_HOPS) {
    return {
      posted: false,
      reason: `This has already been passed between colleagues ${MAX_HOPS} times without being finished. Passing it on again is a loop — finish what you can yourself, and say plainly what is still outstanding and who needs to decide it.`,
    }
  }

  const source: AssignmentSource = {
    kind: 'delegation',
    fromPersonId: args.from.id,
    runId: args.runId,
    hops,
  }
  const [row] = await app.db
    .insert(assignments)
    .values({
      tenantId: args.tenantId,
      personId: colleague.id,
      source,
      title: args.title,
      spec: args.returning
        ? `${args.body}\n\n(This is ${args.from.name} coming back to you with what you asked for. Read it, and carry on with whatever you were doing that needed it. Do not hand it back.)`
        : `${args.body}\n\n(From ${args.from.name}, ${args.from.title}. When you have finished, reply to them with the outcome — it reaches them directly, no email needed.)`,
      formats: args.formats ?? [],
      deliverTo: { name: args.from.name, address: args.from.email },
      dueAt: args.dueAt ?? null,
      createdBy: args.from.id,
    })
    .returning({ id: assignments.id })
  return { posted: true, assignmentId: row!.id, to: colleague.name }
}
