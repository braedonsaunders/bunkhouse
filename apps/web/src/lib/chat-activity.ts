import 'server-only'
import { and, asc, desc, eq, gt, inArray, lte, notInArray, or, sql } from 'drizzle-orm'
import { runEvents, runs } from '../db/schema'
import { db } from '../db/client'
import { replayChatBody } from './chat-reply'

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

type RecordedMessage = { id: string; runId: string | null; role: string; body: string; at: string }
type TimedEventRow = EventRow & { seq: number; createdAt: Date }

/** Never attach later work to an earlier post from the same run. */
export function replayChatMessages(messages: RecordedMessage[], rows: TimedEventRow[]): Map<string, { body: string; activity: ChatMessageActivity[] }> {
  const result = new Map<string, { body: string; activity: ChatMessageActivity[] }>()
  const byRun = new Map<string, RecordedMessage[]>()
  for (const message of messages) {
    if (message.role !== 'agent' || !message.runId) continue
    const group = byRun.get(message.runId) ?? []
    group.push(message)
    byRun.set(message.runId, group)
  }
  const byMessage = new Map<string, TimedEventRow[]>()
  for (const row of rows) {
    const host = byRun.get(row.runId)?.find((message) => new Date(message.at).getTime() >= row.createdAt.getTime())
    if (!host) continue
    const group = byMessage.get(host.id) ?? []
    group.push(row)
    byMessage.set(host.id, group)
  }
  for (const message of messages) {
    const events = byMessage.get(message.id)
    if (!events) continue
    result.set(message.id, {
      body: replayChatBody(events.filter((row) => row.kind === 'message')
        .map((row) => typeof row.payload.text === 'string' ? row.payload.text : ''), message.body),
      activity: foldRun(events),
    })
  }
  return result
}

// Page through evidence rather than silently dropping everything after event 600.
const EVENT_PAGE_SIZE = 600

async function readChatEvents(tenantId: string, runIds: string[], through: Date): Promise<TimedEventRow[]> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const rows: TimedEventRow[] = []
    let cursor: TimedEventRow | undefined
    for (;;) {
      const page: TimedEventRow[] = await app.db
        .select({ runId: runEvents.runId, seq: runEvents.seq, kind: runEvents.kind, payload: runEvents.payload, createdAt: runEvents.createdAt })
        .from(runEvents)
        .where(and(
          inArray(runEvents.runId, runIds),
          inArray(runEvents.kind, ['thought', 'tool_call', 'tool_result', 'message']),
          lte(runEvents.createdAt, through),
          cursor ? or(gt(runEvents.runId, cursor.runId), and(eq(runEvents.runId, cursor.runId), gt(runEvents.seq, cursor.seq))) : undefined,
        ))
        .orderBy(asc(runEvents.runId), asc(runEvents.seq))
        .limit(EVENT_PAGE_SIZE)
      rows.push(...page)
      if (page.length < EVENT_PAGE_SIZE) return rows
      cursor = page.at(-1)
    }
  })
}

/** Rebuild saved replies from the same utterances shown while the run worked. */
export async function chatReplayByMessage(tenantId: string, messages: RecordedMessage[]): Promise<Map<string, { body: string; activity: ChatMessageActivity[] }>> {
  const recorded = messages.filter((message) => message.role === 'agent' && message.runId)
  const runIds = [...new Set(recorded.flatMap((message) => message.runId ? [message.runId] : []))]
  if (runIds.length === 0) return new Map()
  const through = new Date(Math.max(...recorded.map((message) => new Date(message.at).getTime())))
  return replayChatMessages(recorded, await readChatEvents(tenantId, runIds, through))
}

/**
 * The turn that is happening RIGHT NOW, for a reader who just arrived.
 *
 * A streaming reader watches tool cards and prose appear as the run produces
 * them, but none of that is in `chat_messages` yet: the agent's message is
 * appended when the turn finishes. So a reload mid-turn showed the person their
 * own prompt and nothing else — every call already made, every thought, every
 * completed sentence invisible, as though the agent had not started. A run that
 * legitimately works for ten minutes was a blank conversation for ten minutes.
 *
 * This reads the same ledger the finished turn is recovered from, for a run that
 * has not landed its message yet. It is explicitly NOT part of `messages`: the
 * transcript is the append-only record and this is a provisional view of work in
 * progress, which is exactly why it carries the run's status rather than
 * pretending to be a recorded answer.
 *
 * `excludeRunIds` is the runs whose work is already attributed to a message in
 * the transcript — `post_to_conversation` can post mid-run — so their activity
 * is not shown twice.
 */
export type ChatLiveTurn = {
  runId: string
  /** `running`, or one of the `waiting_*` states a run parks in. */
  status: string
  activity: ChatMessageActivity[]
  /** Prose from steps that have completed; the tail may still be unwritten. */
  text: string
}

/** A run that has not reached a terminal state: still working, or parked on a wait. */
const LIVE_RUN_STATUSES = ['running', 'waiting_approval', 'waiting_reply', 'waiting_credential'] as const

export async function chatLiveTurn(
  tenantId: string,
  conversationId: string,
  excludeRunIds: string[],
  /**
   * Duties belonging to this thread. A duty run is triggered by the clock, so
   * its trigger names no conversation — without these, scheduled work the thread
   * asked for runs for ten minutes and the thread shows nothing happening.
   */
  dutyIds: string[] = [],
): Promise<ChatLiveTurn | null> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const belongsToThread = dutyIds.length > 0
      ? or(
          sql`${runs.trigger}->>'conversationId' = ${conversationId}`,
          inArray(sql`${runs.trigger}->>'dutyId'`, dutyIds),
        )
      : sql`${runs.trigger}->>'conversationId' = ${conversationId}`
    const [live] = await app.db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(
        and(
          belongsToThread,
          inArray(runs.status, [...LIVE_RUN_STATUSES]),
          ...(excludeRunIds.length > 0 ? [notInArray(runs.id, excludeRunIds)] : []),
        ),
      )
      .orderBy(desc(runs.startedAt))
      .limit(1)
    if (!live) return null

    // `message` joins the folded kinds here: a completed step's prose is the
    // part of the answer that already exists, and withholding it until the run
    // ends is the very thing this fixes.
    const rows = await readChatEvents(tenantId, [live.id], new Date())

    const typed = rows as EventRow[]
    const text = typed
      .filter((row) => row.kind === 'message')
      .map((row) => (typeof row.payload?.text === 'string' ? row.payload.text.trim() : ''))
      .filter(Boolean)
      .join('\n\n')
    const activity = foldRun(typed.filter((row) => row.kind !== 'message'))
    if (activity.length === 0 && !text) return null
    return { runId: live.id, status: live.status, activity, text }
  })
}
