'use server'

import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { mintLiveKitToken } from '@appkit/voice'
import { browserSessions, browserSteps, callSessions, callTurns, people, runEvents, runs, type BrowserStepDetail } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId as resolveTenant } from '../../lib/tenant'
const resolveTenantId = () => resolveTenant('calls.manage')
import { requireUser } from '../../lib/auth'
import { authenticatedPerson } from '../../lib/person-accounts'
import type { CallActivityEvent } from '../../lib/call-activity'

export type TranscriptTurn = { seq: number; speaker: 'agent' | 'human'; text: string; atMs: number }

/**
 * The newest frame from the agent's browser on this call's run — what it is
 * looking at right now, for the caller to watch on the stage. One frame, never
 * the history: the whole visit replays on the run record.
 */
export type CallBrowserFrame = {
  seq: number
  /** The verb recorded for the step: open, click, type, read, screenshot, close. */
  action: string
  detail: BrowserStepDetail
  /** The captured frame in the files ledger — null when the capture itself failed. */
  fileId: string | null
  /** Offset from the call's start, milliseconds. */
  atMs: number
  /** True while the visit is still open; false once the browser has closed. */
  live: boolean
}

/**
 * Start a web call: the session, its run, and the room token are created only
 * when the caller actually connects — a page load or refresh creates nothing.
 * The caller is the signed-in operator, so the agent knows who it is talking
 * to and where a deliverable would go.
 */
export async function startCallAction(personId: string): Promise<{ sessionId: string; token: string }> {
  const tenantId = await resolveTenantId()
  const user = await requireUser()
  const caller = await authenticatedPerson(tenantId, user)
  const app = db()

  const livekitKey = process.env.LIVEKIT_API_KEY
  const livekitSecret = process.env.LIVEKIT_API_SECRET
  if (!livekitKey || !livekitSecret) {
    throw new Error('LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set — deployment infrastructure, see .env.local.')
  }

  const sessionId = randomUUID()
  const room = `call-${sessionId}`
  const callerName = caller.name
  const counterparty = { name: callerName, identity: `human:${user.id}`, email: caller.email }

  await app.withTenant(tenantId, async () => {
    const [person] = await app.db.select().from(people).where(eq(people.id, personId))
    if (!person || person.kind !== 'agent' || person.status !== 'active' || !person.voiceConfig) {
      throw new Error('This agent cannot take calls right now.')
    }
    const [run] = await app.db
      .insert(runs)
      .values({
        tenantId,
        personId,
        status: 'running',
        trigger: { type: 'chat', conversationId: sessionId },
      })
      .returning({ id: runs.id })
    await app.db.insert(runEvents).values({
      tenantId,
      runId: run!.id,
      seq: 0,
      kind: 'message',
      payload: { text: `Web call started with ${callerName} <${caller.email}>. Room ${room}.` },
    })
    await app.db.insert(callSessions).values({
      id: sessionId,
      tenantId,
      personId,
      runId: run!.id,
      room,
      direction: 'web',
      counterparty,
    })
  })

  const token = await mintLiveKitToken(
    { apiKey: livekitKey, apiSecret: livekitSecret },
    {
      identity: counterparty.identity,
      name: callerName,
      room,
      metadata: JSON.stringify({ tenantId, sessionId }),
    },
  )
  return { sessionId, token }
}

/**
 * Live captions, tool activity, and the agent's screen for the call page —
 * polled together while the call is up, so the page keeps one loop. Tool
 * activity is the call run's own event ledger (the audit trail), offset onto
 * the call clock so it interleaves with the transcript; the browser frame is
 * the newest row of the run's step ledger, fetched by the step ledger's own
 * (session, seq) index rather than by reading the visit's history.
 */
export async function getCallTranscriptAction(sessionId: string): Promise<{
  status: 'active' | 'ended' | 'failed'
  turns: TranscriptTurn[]
  activity: CallActivityEvent[]
  browser: CallBrowserFrame | null
}> {
  const tenantId = await resolveTenantId()
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [session] = await app.db
      .select({ status: callSessions.status, runId: callSessions.runId, startedAt: callSessions.startedAt })
      .from(callSessions)
      .where(eq(callSessions.id, sessionId))
    if (!session) throw new Error('Call session not found.')
    const turns = await app.db
      .select({ seq: callTurns.seq, speaker: callTurns.speaker, text: callTurns.text, atMs: callTurns.atMs })
      .from(callTurns)
      .where(eq(callTurns.sessionId, sessionId))
      .orderBy(asc(callTurns.seq))
    const startedAtMs = session.startedAt.getTime()
    const activity: CallActivityEvent[] = session.runId
      ? (
          await app.db
            .select({ seq: runEvents.seq, kind: runEvents.kind, payload: runEvents.payload, createdAt: runEvents.createdAt })
            .from(runEvents)
            .where(
              and(
                eq(runEvents.runId, session.runId),
                inArray(runEvents.kind, ['tool_call', 'tool_result', 'approval_request']),
              ),
            )
            .orderBy(asc(runEvents.seq))
        ).map((e) => ({
            seq: e.seq,
            kind: e.kind as CallActivityEvent['kind'],
            atMs: Math.max(0, e.createdAt.getTime() - startedAtMs),
            payload: e.payload,
          }))
      : []
    const [frame] = session.runId
      ? await app.db
          .select({
            seq: browserSteps.seq,
            action: browserSteps.action,
            detail: browserSteps.detail,
            fileId: browserSteps.screenshotFileId,
            at: browserSteps.at,
            sessionStatus: browserSessions.status,
          })
          .from(browserSteps)
          .innerJoin(browserSessions, eq(browserSteps.sessionId, browserSessions.id))
          .where(eq(browserSessions.runId, session.runId))
          .orderBy(desc(browserSteps.seq))
          .limit(1)
      : []
    // Closing the browser is a step of its own, so the last step tells us both
    // what the screen shows and whether anyone is still at the keyboard.
    const browser: CallBrowserFrame | null = frame
      ? {
          seq: frame.seq,
          action: frame.action,
          detail: frame.detail,
          fileId: frame.fileId,
          atMs: Math.max(0, frame.at.getTime() - startedAtMs),
          live: frame.sessionStatus === 'active' && frame.action !== 'close',
        }
      : null
    return { status: session.status, turns, activity, browser }
  })
}

/**
 * Hang up from the browser side. Idempotent: only an 'active' session is
 * finalized; the voice agent's own end-of-session pass writes the richer
 * summary if it gets there first.
 */
export async function endCallAction(sessionId: string): Promise<void> {
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    const [session] = await app.db.select().from(callSessions).where(eq(callSessions.id, sessionId))
    if (!session || session.status !== 'active') return
    const endedAt = new Date()
    const durationSeconds = Math.max(0, Math.round((endedAt.getTime() - session.startedAt.getTime()) / 1000))
    await app.db
      .update(callSessions)
      .set({ status: 'ended', endedAt, durationSeconds, updatedAt: endedAt })
      .where(eq(callSessions.id, sessionId))
    if (session.runId) {
      const [run] = await app.db.select().from(runs).where(eq(runs.id, session.runId))
      if (run && run.status === 'running') {
        const minutes = Math.max(1, Math.round(durationSeconds / 60))
        await app.db
          .update(runs)
          .set({
            status: 'completed',
            finishedAt: endedAt,
            summary: `Voice call ended by the caller after ${minutes} minute${minutes === 1 ? '' : 's'}.`,
          })
          .where(eq(runs.id, session.runId))
      }
    }
  })
}
