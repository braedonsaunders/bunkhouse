'use server'

import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { mintLiveKitToken } from '@braedonsaunders/appkit-voice'
import {
  callSessions,
  callTurns,
  chatMessages,
  chatThreads,
  people,
  runEvents,
  runs,
} from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId as resolveTenant } from '../../lib/tenant'
const resolveTenantId = () => resolveTenant('calls.manage')
import { requireUser } from '../../lib/auth'
import { authenticatedPerson } from '../../lib/person-accounts'
import { workRefusal } from '../../lib/person-work'
import { conversationIdFor } from '../../lib/chat-threads'
import type { CallActivityEvent } from '../../lib/call-activity'

export type TranscriptTurn = { seq: number; speaker: 'agent' | 'human'; text: string; atMs: number }

/**
 * Start a web call: the session, its run, and the room token are created only
 * when the caller actually connects — a page load or refresh creates nothing.
 * The caller is the signed-in operator, so the agent knows who it is talking
 * to and where a deliverable would go.
 */
export async function startCallAction(personId: string, threadId: string): Promise<{ sessionId: string; token: string }> {
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
    if (!person) throw new Error('This agent cannot take calls right now.')
    // The same employment gate the run engine keeps, asked here because a call
    // opens its run row before any work reaches `executeAgentRun`.
    const refusal = workRefusal(person)
    if (refusal) throw new Error(refusal.reason)
    if (!person.voiceConfig) throw new Error('This agent is not set up to take calls yet.')
    const [thread] = await app.db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(and(eq(chatThreads.id, threadId), eq(chatThreads.personId, personId), eq(chatThreads.userId, user.id)))
      .limit(1)
    if (!thread) throw new Error('That conversation is not available for this call.')
    const [run] = await app.db
      .insert(runs)
      .values({
        tenantId,
        personId,
        status: 'running',
        trigger: { type: 'chat', conversationId: conversationIdFor(threadId) },
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

/** Live captions and tool activity for the conversation's call stage. */
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
 * Hang up from the browser side. Session finalization and transcript copying
 * are both idempotent, so the media room and voice worker may race safely.
 */
export async function endCallAction(sessionId: string): Promise<void> {
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    const [session] = await app.db.select().from(callSessions).where(eq(callSessions.id, sessionId))
    if (!session) return
    const [callee] = await app.db.select({ name: people.name }).from(people).where(eq(people.id, session.personId)).limit(1)
    const endedAt = session.endedAt ?? new Date()
    const durationSeconds = session.durationSeconds ?? Math.max(0, Math.round((endedAt.getTime() - session.startedAt.getTime()) / 1000))
    if (session.status === 'active') {
      await app.db
        .update(callSessions)
        .set({ status: 'ended', endedAt, durationSeconds, updatedAt: endedAt })
        .where(eq(callSessions.id, sessionId))
    }
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

      // A unified call remains a readable conversation after its media room
      // closes. Copy only the call-turn suffix that is not already in chat;
      // this makes a disconnect retry safe even if the last caption lands a
      // moment after the first close request. The immutable call ledger stays
      // authoritative and runId is the provenance join.
      const conversationId = run?.trigger.type === 'chat' ? run.trigger.conversationId : ''
      if (conversationId.startsWith('web:')) {
        const threadId = conversationId.slice(4)
        await app.db.transaction(async (tx) => {
          // Share the conversation writer's lock: a call finishing and an
          // ordinary message retry must never choose the same next sequence.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext('bunkhouse.chat_messages'), hashtext(${threadId}))`)
          const [copied] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(chatMessages)
            .where(and(eq(chatMessages.threadId, threadId), eq(chatMessages.runId, session.runId!)))
          const turns = await tx
            .select({ speaker: callTurns.speaker, text: callTurns.text, atMs: callTurns.atMs })
            .from(callTurns)
            .where(eq(callTurns.sessionId, sessionId))
            .orderBy(asc(callTurns.seq))
          const spoken = turns.filter((turn) => turn.text.trim()).slice(copied?.count ?? 0)
          if (spoken.length === 0) return
          const [last] = await tx
            .select({ seq: sql<number>`coalesce(max(${chatMessages.seq}), -1)::int` })
            .from(chatMessages)
            .where(eq(chatMessages.threadId, threadId))
          const base = last?.seq ?? -1
          await tx.insert(chatMessages).values(spoken.map((turn, index) => ({
            tenantId,
            threadId,
            seq: base + index + 1,
            role: turn.speaker === 'human' ? 'user' as const : 'agent' as const,
            body: turn.text.trim(),
            runId: session.runId,
            at: new Date(session.startedAt.getTime() + turn.atMs),
          })))
          const lastAt = new Date(session.startedAt.getTime() + (spoken.at(-1)?.atMs ?? 0))
          await tx
            .update(chatThreads)
            .set({
              title: sql`coalesce(${chatThreads.title}, ${`Call with ${callee?.name ?? 'employee'}`})`,
              lastMessageAt: lastAt,
              updatedAt: lastAt,
            })
            .where(eq(chatThreads.id, threadId))
        })
      }
    }
  })
}
