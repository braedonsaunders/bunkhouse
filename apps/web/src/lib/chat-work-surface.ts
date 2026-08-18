import 'server-only'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  browserSessions,
  browserSteps,
  callSessions,
  chatThreads,
  deskEvents,
  deskSessions,
  runEvents,
  runs,
} from '../db/schema'
import { db } from '../db/client'
import { conversationIdFor } from './chat-threads'

const DISTINCT_BROWSER_DESK_EVENTS = new Set(['navigate', 'read', 'screenshot'])
const SHARED_BROWSER_DESK_EVENTS = new Set(['click', 'type', 'key', 'scroll'])

function isBrowserDeskEvent(kind: string, detail: Record<string, unknown>): boolean {
  if (DISTINCT_BROWSER_DESK_EVENTS.has(kind)) return true
  return (
    SHARED_BROWSER_DESK_EVENTS.has(kind) &&
    (typeof detail.url === 'string' ||
      typeof detail.title === 'string' ||
      (typeof detail.target === 'string' && detail.x === undefined))
  )
}

export type ChatWorkSurface =
  | { kind: 'idle'; runId: null }
  | { kind: 'desktop'; runId: string; status: string }
  | {
      kind: 'browser'
      runId: string
      status: string
      frame: { fileId: string | null; title: string; url: string | null; action: string; at: string }
    }
  | { kind: 'call'; runId: string; status: string; direction: string; startedAt: string }
  | {
      kind: 'activity'
      runId: string
      status: string
      events: { seq: number; kind: string; label: string; at: string }[]
    }

function eventLabel(kind: string, payload: Record<string, unknown>): string {
  if (kind === 'tool_call') return `Using ${String(payload.toolName ?? 'a connected tool').replaceAll('_', ' ')}`
  if (kind === 'tool_result') return `${String(payload.toolName ?? 'Tool').replaceAll('_', ' ')} finished`
  if (kind === 'approval_request') return String(payload.description ?? 'Waiting for approval')
  if (kind === 'error') return String(payload.message ?? 'A step did not finish')
  if (kind === 'message') return String(payload.text ?? 'Working')
  return kind.replaceAll('_', ' ')
}

/** Resolve the live surface belonging to the newest run in one conversation. */
export async function chatWorkSurface(tenantId: string, threadId: string): Promise<ChatWorkSurface> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [thread] = await app.db.select({ id: chatThreads.id }).from(chatThreads).where(eq(chatThreads.id, threadId)).limit(1)
    if (!thread) return { kind: 'idle', runId: null }
    const [run] = await app.db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(sql`${runs.trigger}->>'conversationId' = ${conversationIdFor(threadId)}`)
      .orderBy(desc(runs.startedAt))
      .limit(1)
    if (!run) return { kind: 'idle', runId: null }

    const [desk] = await app.db
      .select({
        id: deskSessions.id,
        status: deskSessions.status,
      })
      .from(deskSessions)
      .where(eq(deskSessions.runId, run.id))
      .orderBy(desc(deskSessions.startedAt))
      .limit(1)
    const [latestScreenBoundary] = desk
      ? await app.db
          .select({ kind: deskEvents.kind })
          .from(deskEvents)
          .where(and(eq(deskEvents.sessionId, desk.id), inArray(deskEvents.kind, ['screen_open', 'screen_close'])))
          .orderBy(desc(deskEvents.seq))
          .limit(1)
      : []
    if (desk?.status === 'active' && latestScreenBoundary?.kind === 'screen_open') {
      return { kind: 'desktop', runId: run.id, status: run.status }
    }

    const [call] = await app.db
      .select({ status: callSessions.status, direction: callSessions.direction, startedAt: callSessions.startedAt })
      .from(callSessions)
      .where(and(eq(callSessions.runId, run.id), eq(callSessions.status, 'active')))
      .orderBy(desc(callSessions.startedAt))
      .limit(1)

    // The current browser driver writes to Desk's one governed event stream.
    // Promote it only when it is the newest thing the desk is doing, so a
    // stale browser frame never covers newer headless, shell, or call work.
    const [latestDeskEvent] = desk
      ? await app.db
          .select({
            kind: deskEvents.kind,
            detail: deskEvents.detail,
            screenshotFileId: deskEvents.screenshotFileId,
            at: deskEvents.at,
          })
          .from(deskEvents)
          .where(eq(deskEvents.sessionId, desk.id))
          .orderBy(desc(deskEvents.seq))
          .limit(1)
      : []
    if (
      desk?.status === 'active' &&
      latestDeskEvent &&
      isBrowserDeskEvent(latestDeskEvent.kind, latestDeskEvent.detail) &&
      (!call || latestDeskEvent.at >= call.startedAt)
    ) {
      const detail = latestDeskEvent.detail
      return {
        kind: 'browser',
        runId: run.id,
        status: desk?.status ?? run.status,
        frame: {
          fileId: latestDeskEvent.screenshotFileId,
          title: detail.title ?? detail.url ?? 'Browser',
          url: detail.url ?? null,
          action: detail.target ? `${latestDeskEvent.kind}: ${detail.target}` : latestDeskEvent.kind,
          at: latestDeskEvent.at.toISOString(),
        },
      }
    }

    // Compatibility for sessions created before browser work moved onto Desk.
    const [browser] = await app.db
      .select({ id: browserSessions.id, status: browserSessions.status })
      .from(browserSessions)
      .where(eq(browserSessions.runId, run.id))
      .orderBy(desc(browserSessions.startedAt))
      .limit(1)
    if (browser) {
      const [step] = await app.db
        .select({
          fileId: browserSteps.screenshotFileId,
          action: browserSteps.action,
          detail: browserSteps.detail,
          at: browserSteps.at,
        })
        .from(browserSteps)
        .where(eq(browserSteps.sessionId, browser.id))
        .orderBy(desc(browserSteps.seq))
        .limit(1)
      if (step && browser.status === 'active' && (!call || step.at >= call.startedAt)) {
        return {
          kind: 'browser',
          runId: run.id,
          status: browser.status,
          frame: {
            fileId: step.fileId,
            title: step.detail.title ?? step.detail.url ?? 'Browser',
            url: step.detail.url ?? null,
            action: step.detail.target ? `${step.action}: ${step.detail.target}` : step.action,
            at: step.at.toISOString(),
          },
        }
      }
    }

    if (call) {
      return {
        kind: 'call',
        runId: run.id,
        status: call.status,
        direction: call.direction,
        startedAt: call.startedAt.toISOString(),
      }
    }

    // A desk can be intentionally headless. Its latest events still make the
    // work visible instead of presenting an empty desktop as though nothing is happening.
    const latestDeskEvents = desk
      ? await app.db
          .select({ seq: deskEvents.seq, kind: deskEvents.kind, detail: deskEvents.detail, at: deskEvents.at })
          .from(deskEvents)
          .where(eq(deskEvents.sessionId, desk.id))
          .orderBy(desc(deskEvents.seq))
          .limit(8)
      : []
    const latestRunEvents = await app.db
      .select({ seq: runEvents.seq, kind: runEvents.kind, payload: runEvents.payload, at: runEvents.createdAt })
      .from(runEvents)
      .where(eq(runEvents.runId, run.id))
      .orderBy(desc(runEvents.seq))
      .limit(8)
    const events = (
      latestDeskEvents.length
        ? latestDeskEvents.map((event) => ({
            seq: event.seq,
            kind: event.kind,
            label: eventLabel(event.kind, event.detail),
            at: event.at.toISOString(),
          }))
        : latestRunEvents.map((event) => ({
            seq: event.seq,
            kind: event.kind,
            label: eventLabel(event.kind, event.payload),
            at: event.at.toISOString(),
          }))
    ).reverse()
    return { kind: 'activity', runId: run.id, status: run.status, events }
  })
}
