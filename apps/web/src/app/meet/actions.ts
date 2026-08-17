'use server'

import { eq } from 'drizzle-orm'
import { mintLiveKitToken } from '@braedonsaunders/appkit-voice'
import { callSessions, meetingLinks, runs } from '../../db/schema'
import { db } from '../../db/client'
import { lookupMeetingByToken } from '../../lib/meetings'

/**
 * The guest side of a meeting. Everything here is reached without a session:
 * the link token IS the credential, so every action re-validates it from
 * scratch and never trusts anything else the browser sends.
 */

const JOIN_FAILURES: Record<'unknown' | 'expired' | 'ended' | 'unavailable', string> = {
  unknown: 'This meeting link is not valid.',
  expired: 'This meeting link has expired.',
  ended: 'This meeting has already ended.',
  unavailable: 'This meeting is no longer available.',
}

/** How long a guest's room token stays valid — one long meeting's worth. */
const GUEST_TOKEN_TTL_SECONDS = 4 * 60 * 60

/**
 * Walk in. Marks the link used, starts the meeting clock on first arrival,
 * and hands back a room token scoped to this meeting and nothing else.
 */
export async function joinMeetingAction(
  token: string,
  displayName: string,
): Promise<{ token: string; sessionId: string }> {
  const meeting = await lookupMeetingByToken(token)
  if (!meeting.ok) throw new Error(JOIN_FAILURES[meeting.reason])

  const livekitKey = process.env.LIVEKIT_API_KEY
  const livekitSecret = process.env.LIVEKIT_API_SECRET
  if (!livekitKey || !livekitSecret) {
    throw new Error('LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set — deployment infrastructure, see .env.local.')
  }

  const name = displayName.trim().slice(0, 60) || 'Guest'
  const app = db()
  if (!meeting.joinedAt) {
    // The meeting starts when someone actually walks in — the session was
    // created when the invitation went out, which may have been yesterday.
    // The guest's own name replaces the placeholder on the record; the address
    // the invitation went to stays, since that is where anything the agent
    // takes on in the meeting gets delivered.
    const now = new Date()
    await app.withTenant(meeting.tenantId, async () => {
      const [session] = await app.db.select().from(callSessions).where(eq(callSessions.id, meeting.sessionId))
      if (!session) return
      await app.db
        .update(meetingLinks)
        .set({ joinedAt: now, updatedAt: now })
        .where(eq(meetingLinks.token, token))
      await app.db
        .update(callSessions)
        .set({
          startedAt: now,
          counterparty: { ...session.counterparty, name, identity: `guest:${token.slice(0, 12)}` },
          updatedAt: now,
        })
        .where(eq(callSessions.id, meeting.sessionId))
    })
  }

  const roomToken = await mintLiveKitToken(
    { apiKey: livekitKey, apiSecret: livekitSecret },
    {
      identity: `guest:${token.slice(0, 12)}`,
      name,
      room: meeting.room,
      metadata: JSON.stringify({ tenantId: meeting.tenantId, sessionId: meeting.sessionId }),
      ttlSeconds: GUEST_TOKEN_TTL_SECONDS,
    },
  )
  return { token: roomToken, sessionId: meeting.sessionId }
}

/**
 * Leave. Idempotent, and deliberately modest: the voice worker writes the
 * richer summary when it shuts down, so this only closes a ledger the worker
 * has not closed already.
 */
export async function leaveMeetingAction(token: string): Promise<void> {
  const app = db()
  const [link] = await app.withSuperAdmin((superDb) =>
    superDb.select().from(meetingLinks).where(eq(meetingLinks.token, token)),
  )
  if (!link) return
  await app.withTenant(link.tenantId, async () => {
    const [session] = await app.db.select().from(callSessions).where(eq(callSessions.id, link.sessionId))
    if (!session || session.status !== 'active') return
    const endedAt = new Date()
    const durationSeconds = Math.max(0, Math.round((endedAt.getTime() - session.startedAt.getTime()) / 1000))
    await app.db
      .update(callSessions)
      .set({ status: 'ended', endedAt, durationSeconds, updatedAt: endedAt })
      .where(eq(callSessions.id, session.id))
    if (session.runId) {
      const [run] = await app.db.select().from(runs).where(eq(runs.id, session.runId))
      if (run && run.status === 'running') {
        const minutes = Math.max(1, Math.round(durationSeconds / 60))
        await app.db
          .update(runs)
          .set({
            status: 'completed',
            finishedAt: endedAt,
            summary: `Video meeting ended by the guest after ${minutes} minute${minutes === 1 ? '' : 's'}.`,
          })
          .where(eq(runs.id, session.runId))
      }
    }
  })
}
