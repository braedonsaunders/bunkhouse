'use server'

import { asc, eq } from 'drizzle-orm'
import { callSessions, callTurns, runs } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId } from '../../lib/tenant'

export type TranscriptTurn = { seq: number; speaker: 'hand' | 'human'; text: string; atMs: number }

/** Live captions for the call page — polled while the call is up. */
export async function getCallTranscriptAction(sessionId: string): Promise<{
  status: 'active' | 'ended' | 'failed'
  turns: TranscriptTurn[]
}> {
  const tenantId = await resolveTenantId()
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [session] = await app.db
      .select({ status: callSessions.status })
      .from(callSessions)
      .where(eq(callSessions.id, sessionId))
    if (!session) throw new Error('Call session not found.')
    const turns = await app.db
      .select({ seq: callTurns.seq, speaker: callTurns.speaker, text: callTurns.text, atMs: callTurns.atMs })
      .from(callTurns)
      .where(eq(callTurns.sessionId, sessionId))
      .orderBy(asc(callTurns.seq))
    return { status: session.status, turns }
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
