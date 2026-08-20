import 'server-only'
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import { memories, people, runEvents, runs } from '../db/schema'
import { db } from '../db/client'
import { expireNote } from './memory'

/**
 * Retiring a belief the ledger disagrees with.
 *
 * An agent writes down what it learns, which is the point of a logbook — but
 * some of what it learns is about the system it is running in, and that changes
 * underneath the note. One agent has a live note reading "run_shell is broken
 * in this environment — use run_script"; another, "My mailbox is not
 * provisioned — all mail tools return No mailbox connected". Both were true and
 * carefully written. Both are read back into every subsequent run, at the top
 * of the context, and both will go on shaping how that agent works long after
 * the thing they describe is fixed. An agent that believes it cannot do
 * something does not try, so the note is self-confirming: nothing ever
 * contradicts it, because the belief prevents the attempt that would.
 *
 * That is not a memory problem to be solved by better remembering. A claim
 * about whether a tool works is a claim with ground truth sitting right next to
 * it — the run ledger, which records every tool call and what came back. So the
 * note is checked against the evidence rather than trusted or re-read: a note
 * naming a tool as broken is retired the moment that tool is seen working, for
 * that agent, after the note was written.
 *
 * Deliberately narrow, and deliberately not a model's judgement:
 *
 * - only agent-scoped notes, only ones that NAME a tool and say it fails;
 * - only retired on a success by the same agent, dated after the note;
 * - `expireNote`, never a delete — the note stays in history with the date it
 *   stopped being true, which is exactly what a superseded fact should look
 *   like.
 *
 * The company-scoped gardener does not cover any of this: it only ever looks at
 * scope 'company', so an agent's own logbook has never been gardened at all.
 */

/** Words that turn "this tool" into "this tool does not work". */
const FAILURE_LANGUAGE = new RegExp(
  [
    '\\b(fail(s|ed|ing)?|broken|unusable|blocked|unavailable|unprovisioned)\\b',
    "\\b(cannot|can't|can not|does not work|doesn't work|not available|not provisioned|not connected)\\b",
    // How the tools themselves phrase a refusal, which is how an agent quotes
    // it back: "returns No mailbox connected", "no permission to create".
    '\\bno\\s+\\w+\\s+(connected|configured|provisioned|available)\\b',
    '\\bno\\s+(mailbox|permission|permissions|access|executor)\\b',
    '\\b(refus(e|es|ed|al)|denied|not permitted|error(s|ed)?)\\b',
  ].join('|'),
  'i',
)

/** A tool name as it appears in prose: snake_case, two words or more. */
const TOOL_NAME = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g

/**
 * Did this come back as a success? The ledger stores whatever the tool
 * returned, and the shapes that mean "no" are the same handful everywhere: an
 * error, a refusal by the dial, or a park awaiting sign-off. Anything else did
 * the thing.
 */
export function ledgeredSuccess(output: unknown): boolean {
  if (output === null || output === undefined) return false
  if (typeof output !== 'object') return true
  const record = output as Record<string, unknown>
  if (typeof record.error === 'string' && record.error.trim()) return false
  if (record.status === 'forbidden' || record.status === 'pending_approval') return false
  // The colleague tools answer in their own words rather than by throwing.
  if (record.sent === false || record.posted === false || record.delegated === false) return false
  if (record.scheduled === false) return false
  return true
}

/** Which tools a note claims are not working. Empty when it claims nothing. */
export function toolsClaimedBroken(body: string, known: ReadonlySet<string>): string[] {
  const named = [...new Set(body.match(TOOL_NAME) ?? [])].filter((name) => known.has(name))
  if (named.length === 0) return []
  // The claim has to be about failure. A note that merely mentions a tool by
  // name — "used run_shell to tidy the exports" — is a record of work, not a
  // belief about the platform, and retiring it would lose real history.
  return FAILURE_LANGUAGE.test(body) ? named : []
}

/**
 * The tool names a note may be making a claim about.
 *
 * Kept as a plain list rather than resolved from `assembleAbilities`, which
 * needs a person, a run and live integrations — none of which this pass has,
 * and none of which change the answer. A name that is not a tool is not a
 * claim about a tool, and a tool missing from this list simply never retires a
 * note, which is the safe direction to be wrong in.
 */
const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  'email_colleague',
  'send_email',
  'ask_and_wait',
  'reply_to_thread',
  'delegate_to_colleague',
  'post_to_conversation',
  'start_subagent',
  'invoke_report',
  'await_launched_work',
  'take_assignment',
  'run_shell',
  'run_script',
  'list_workspace_files',
  'read_workspace_file',
  'write_workspace_file',
  'web_search',
  'read_webpage',
  'read_page',
  'browser_open',
  'browser_click',
  'browser_read',
  'browser_type',
  'browser_close',
  'create_document',
  'list_document_templates',
  'save_memory',
  'search_memory',
  'schedule_task',
  'list_scheduled_tasks',
  'cancel_scheduled_task',
  'cite_procedure',
  'list_tools',
  'run_tool',
  'send_sms',
  'place_call',
  'open_desktop',
  'close_desktop',
  'desktop_screenshot',
  'desktop_click',
  'desktop_type',
  'desktop_key',
  'desktop_scroll',
  'desktop_drag',
  'desktop_invoke',
  'desktop_windows',
  'desktop_focus',
  'desktop_open_app',
  'request_takeover',
])

export type RetiredBelief = { agent: string; note: string; tool: string }

/**
 * One pass over one company. Cheap enough to run often: two indexed reads and
 * an update only where the evidence is unambiguous.
 */
export async function retireContradictedBeliefs(tenantId: string): Promise<RetiredBelief[]> {
  const app = db()
  return app.withTenant(tenantId, async () => {
    const live = await app.db
      .select({
        id: memories.id,
        personId: memories.personId,
        title: memories.title,
        body: memories.body,
        createdAt: memories.createdAt,
      })
      .from(memories)
      .where(and(eq(memories.scope, 'agent'), isNull(memories.validUntil), eq(memories.status, 'active')))
    if (live.length === 0) return []

    const staff = new Map(
      (await app.db.select({ id: people.id, name: people.name }).from(people)).map((row) => [row.id, row.name]),
    )
    const retired: RetiredBelief[] = []

    for (const note of live) {
      if (!note.personId) continue
      // Every tool this agent has actually used since the note was written,
      // and whether it worked. One query per candidate note, and only notes
      // that make a claim get one.
      const claims = toolsClaimedBroken(note.body, KNOWN_TOOLS)
      if (claims.length === 0) continue

      const evidence = await app.db
        .select({ toolName: sql<string>`${runEvents.payload} ->> 'toolName'`, output: runEvents.payload })
        .from(runEvents)
        .innerJoin(runs, eq(runs.id, runEvents.runId))
        .where(
          and(
            eq(runs.personId, note.personId),
            eq(runEvents.kind, 'tool_result'),
            gt(runEvents.createdAt, note.createdAt),
            // A bare `any(${claims})` expands the array into one bind parameter
            // per element — `any(($1, $2))` — which Postgres rejects. inArray
            // builds the IN list the driver can actually plan.
            inArray(sql<string>`${runEvents.payload} ->> 'toolName'`, claims),
          ),
        )

      const worked = evidence.find((row) => ledgeredSuccess((row.output as Record<string, unknown>).output))
      if (!worked) continue
      await expireNote(tenantId, note.id)
      retired.push({
        agent: staff.get(note.personId) ?? 'an agent',
        note: note.title,
        tool: worked.toolName,
      })
    }
    return retired
  })
}
