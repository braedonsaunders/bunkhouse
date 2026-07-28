'use server'

import { and, asc, eq, inArray } from 'drizzle-orm'
import { callSessions, callTurns, runEvents, runs } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId } from '../../lib/tenant'
import type { CallActivityEvent } from '../../lib/call-activity'

export type TranscriptTurn = { seq: number; speaker: 'agent' | 'human'; text: string; atMs: number }

/**
 * Live captions and tool activity for the call page — polled while the call
 * is up. Tool activity is the call run's own event ledger (the audit trail),
 * offset onto the call clock so it interleaves with the transcript.
 */
export async function getCallTranscriptAction(sessionId: string): Promise<{
  status: 'active' | 'ended' | 'failed'
  turns: TranscriptTurn[]
  activity: CallActivityEvent[]
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
    return { status: session.status, turns, activity }
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
