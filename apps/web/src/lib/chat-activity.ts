import 'server-only'
import { and, asc, inArray } from 'drizzle-orm'
import { runEvents } from '../db/schema'
import { db } from '../db/client'

/**
 * What an agent turn did, recovered from the run ledger for a reloaded
 * conversation.
 *
 * A streamed turn arrives with the model's reasoning and tool cards already
 * shaped by the SDK. A turn read back out of the database had, until this
 * module, only its final prose: `chat_messages` stores a body, so a reload
 * replaced a worked-through answer with a bare conclusion and no visible path
 * to it.
 *
 * Nothing here is a second copy of anything. `run_events` has recorded the
 * tool calls all along and now records the thinking too, keyed by the same
 * `runId` that `chat_messages` already carries as "the join back to the work" —
 * this reads that evidence rather than duplicating it into the transcript.
 * That also means the ledger stays the single account of what happened: if the
 * two ever disagreed, there would be no way to say which was the record.
 */
export type ChatMessageActivity =
  | { kind: 'thought'; text: string }
  | {
      kind: 'tool'
      toolName: string
      input: unknown
      /** Null while a call never returned — a run that died mid-tool. */
      output: unknown | null
      ok: boolean
    }

type EventRow = { runId: string; kind: string; payload: Record<string, unknown> }

/**
 * Fold one run's events into the order a reader should meet them in.
 *
 * Results are matched to their calls by `toolCallId` where the provider gave
 * one, and fall back to the first unmatched call of the same name — parallel
 * calls to different tools are ordinary, two unmatched calls to the SAME tool
 * in one step are not, and guessing between them would silently attach the
 * wrong output to the wrong card.
 */
function foldRun(rows: EventRow[]): ChatMessageActivity[] {
  const activity: ChatMessageActivity[] = []
  const callIndex = new Map<string, number>()
  const unmatchedByName = new Map<string, number[]>()

  for (const row of rows) {
    const payload = row.payload ?? {}
    if (row.kind === 'thought') {
      const text = typeof payload.text === 'string' ? payload.text.trim() : ''
      if (text) activity.push({ kind: 'thought', text })
      continue
    }
    if (row.kind === 'tool_call') {
      const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'tool'
      const at = activity.push({ kind: 'tool', toolName, input: payload.input ?? null, output: null, ok: true }) - 1
      const id = typeof payload.toolCallId === 'string' ? payload.toolCallId : null
      if (id) callIndex.set(id, at)
      else unmatchedByName.set(toolName, [...(unmatchedByName.get(toolName) ?? []), at])
      continue
    }
    if (row.kind !== 'tool_result') continue

    const id = typeof payload.toolCallId === 'string' ? payload.toolCallId : null
    const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'tool'
    let at = id !== undefined && id !== null ? callIndex.get(id) : undefined
    if (at === undefined) {
      const queue = unmatchedByName.get(toolName)
      at = queue?.shift()
    }
    if (at === undefined) continue
    const entry = activity[at]
    if (!entry || entry.kind !== 'tool') continue
    const output = payload.output ?? null
    // The panel's own error styling keys off `output.ok === false`; mirror the
    // same reading here so a failed step looks failed after a reload too.
    const ok = !(typeof output === 'object' && output !== null && (output as { ok?: unknown }).ok === false)
    activity[at] = { ...entry, output, ok }
  }
  return activity
}

/**
 * The fold, reachable from the suite. The ordering and call/result pairing
 * rules are the part with judgement in them; exporting them under this name
 * keeps that testable without standing up a database, while the underscore
 * says plainly that nothing in the application should call it.
 */
export const __foldRunForTests = foldRun

/**
 * Ordered activity for a set of runs, by run id.
 *
 * Bounded per read: a long agentic run can carry thousands of events, and a
 * conversation is a reading surface rather than the audit surface — the run
 * record replays the whole thing. Truncation drops the OLDEST events, because
 * the tail is what the final answer came out of.
 */
const MAX_EVENTS_PER_THREAD = 600

export async function chatActivityByRun(
  tenantId: string,
  runIds: string[],
): Promise<Map<string, ChatMessageActivity[]>> {
  const grouped = new Map<string, ChatMessageActivity[]>()
  if (runIds.length === 0) return grouped
  const app = db()
  const rows = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ runId: runEvents.runId, kind: runEvents.kind, payload: runEvents.payload })
      .from(runEvents)
      .where(and(inArray(runEvents.runId, runIds), inArray(runEvents.kind, ['thought', 'tool_call', 'tool_result'])))
      .orderBy(asc(runEvents.runId), asc(runEvents.seq))
      .limit(MAX_EVENTS_PER_THREAD),
  )

  const byRun = new Map<string, EventRow[]>()
  for (const row of rows as EventRow[]) {
    byRun.set(row.runId, [...(byRun.get(row.runId) ?? []), row])
  }
  for (const [runId, runRows] of byRun) {
    const folded = foldRun(runRows)
    if (folded.length > 0) grouped.set(runId, folded)
  }
  return grouped
}
