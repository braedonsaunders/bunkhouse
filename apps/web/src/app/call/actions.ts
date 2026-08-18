'use server'

import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import { mintLiveKitToken } from '@braedonsaunders/appkit-voice'
import type { RemoteViewerConnection } from '@braedonsaunders/appkit-remote-sessions'
import type { TerminalSurfaceEntry } from '@braedonsaunders/appkit-remote-sessions/react'
import {
  browserSessions,
  browserSteps,
  callSessions,
  callTurns,
  deskEvents,
  deskSessions,
  people,
  remoteComputers,
  remoteSessionEvents,
  remoteSessions,
  runEvents,
  runs,
  type DeskLedgerEventDetail,
} from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId as resolveTenant } from '../../lib/tenant'
const resolveTenantId = () => resolveTenant('calls.manage')
import { requireUser } from '../../lib/auth'
import { authenticatedPerson } from '../../lib/person-accounts'
import { workRefusal } from '../../lib/person-work'
import type { CallActivityEvent } from '../../lib/call-activity'
import { observeRemoteWork } from '../../lib/remote-computers'

export type TranscriptTurn = { seq: number; speaker: 'agent' | 'human'; text: string; atMs: number }

/**
 * The newest recorded frame from the agent's desk on this call's run — what it
 * is looking at right now, for the caller to watch on the stage. One frame,
 * never the history: the whole session replays on the run record. Old runs
 * that recorded onto the legacy browser ledger still feed the same shape.
 */
export type CallBrowserFrame = {
  seq: number
  /** The desk ledger kind (navigate, click, screenshot, …) or, for legacy
   *  browser rows, the step verb (open, click, type, read, screenshot, close). */
  action: string
  detail: DeskLedgerEventDetail
  /** The captured frame in the files ledger — null when the capture itself failed. */
  fileId: string | null
  /** Offset from the call's start, milliseconds. */
  atMs: number
  /** True while the session is still open; false once the desk work has ended. */
  live: boolean
}

export type CallTerminalFrame = {
  seq: number
  command: string
  cwd: string | null
  output: string
  outputTruncated: boolean
  exitCode: number | null
  atMs: number
}

export type CallRemoteSurface = {
  sessionId: string
  computerName: string
  kind: 'computer' | 'terminal'
  protocol: string
  status: string
  atMs: number
  terminal: { entries: TerminalSurfaceEntry[]; status: 'idle' | 'running' | 'failed' | 'completed' } | null
}

/** Mint a short-lived observer connection only for remote work on this call's run. */
export async function observeCallRemoteWorkSurfaceAction(input: {
  callSessionId: string
  remoteSessionId: string
}): Promise<RemoteViewerConnection> {
  const tenantId = await resolveTenantId()
  const user = await requireUser()
  const app = db()
  const allowed = await app.withTenantContext(tenantId, async () => {
    const [row] = await app.db
      .select({ id: remoteSessions.id })
      .from(remoteSessions)
      .innerJoin(callSessions, eq(callSessions.runId, remoteSessions.runId))
      .where(and(eq(callSessions.id, input.callSessionId), eq(remoteSessions.id, input.remoteSessionId)))
      .limit(1)
    return row
  })
  if (!allowed) throw new Error('That remote computer is not part of this call.')
  return observeRemoteWork({ tenantId, sessionId: input.remoteSessionId, holder: `operator:${user.id}` })
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
    if (!person) throw new Error('This agent cannot take calls right now.')
    // The same employment gate the run engine keeps, asked here because a call
    // opens its run row before any work reaches `executeAgentRun`.
    const refusal = workRefusal(person)
    if (refusal) throw new Error(refusal.reason)
    if (!person.voiceConfig) throw new Error('This agent is not set up to take calls yet.')
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
 * the call clock so it interleaves with the transcript; the screen still is
 * the newest frame-bearing row of the run's desk ledger, fetched by the
 * ledger's own (session, seq) index rather than by reading the session's
 * history.
 */
export async function getCallTranscriptAction(sessionId: string): Promise<{
  status: 'active' | 'ended' | 'failed'
  turns: TranscriptTurn[]
  activity: CallActivityEvent[]
  browser: CallBrowserFrame | null
  terminal: CallTerminalFrame | null
  remote: CallRemoteSurface | null
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
    // The still comes from the run's desk session: the newest ledger event
    // that carried a frame (shell commands record no picture, so the newest
    // row alone could blank the stage mid-visit). Runs from before the desk
    // fall back to the legacy browser step ledger, which is preserved history.
    const [deskSession] = session.runId
      ? await app.db
          .select({ id: deskSessions.id, status: deskSessions.status })
          .from(deskSessions)
          .where(eq(deskSessions.runId, session.runId))
      : []
    let browser: CallBrowserFrame | null = null
    let terminal: CallTerminalFrame | null = null
    let remote: CallRemoteSurface | null = null
    if (deskSession) {
      const [event] = await app.db
        .select({
          seq: deskEvents.seq,
          kind: deskEvents.kind,
          detail: deskEvents.detail,
          fileId: deskEvents.screenshotFileId,
          at: deskEvents.at,
        })
        .from(deskEvents)
        .where(and(eq(deskEvents.sessionId, deskSession.id), isNotNull(deskEvents.screenshotFileId)))
        .orderBy(desc(deskEvents.seq))
        .limit(1)
      // Closing the browser or the screen is an event of its own, so the kind
      // says whether anyone is still at the keyboard.
      browser = event
        ? {
            seq: event.seq,
            action: event.kind,
            detail: event.detail,
            fileId: event.fileId,
            atMs: Math.max(0, event.at.getTime() - startedAtMs),
            live:
              deskSession.status === 'active' &&
              event.kind !== 'browser_close' &&
              event.kind !== 'screen_close',
          }
        : null
      const [shell] = await app.db
        .select({ seq: deskEvents.seq, detail: deskEvents.detail, at: deskEvents.at })
        .from(deskEvents)
        .where(and(eq(deskEvents.sessionId, deskSession.id), eq(deskEvents.kind, 'shell_command')))
        .orderBy(desc(deskEvents.seq))
        .limit(1)
      terminal = shell
        ? {
            seq: shell.seq,
            command: shell.detail.command ?? '',
            cwd: shell.detail.cwd ?? null,
            output: shell.detail.output ?? '',
            outputTruncated: shell.detail.outputTruncated === true,
            exitCode: shell.detail.exitCode ?? null,
            atMs: Math.max(0, shell.at.getTime() - startedAtMs),
          }
        : null
    } else if (session.runId) {
      const [frame] = await app.db
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
      browser = frame
        ? {
            seq: frame.seq,
            action: frame.action,
            detail: frame.detail,
            fileId: frame.fileId,
            atMs: Math.max(0, frame.at.getTime() - startedAtMs),
            live: frame.sessionStatus === 'active' && frame.action !== 'close',
          }
        : null
    }
    if (session.runId) {
      const [remoteRow] = await app.db
        .select({
          sessionId: remoteSessions.id,
          computerName: remoteComputers.name,
          kind: remoteSessions.kind,
          protocol: remoteSessions.protocol,
          status: remoteSessions.status,
          lastActivityAt: remoteSessions.lastActivityAt,
        })
        .from(remoteSessions)
        .innerJoin(remoteComputers, eq(remoteComputers.id, remoteSessions.computerId))
        .where(and(eq(remoteSessions.runId, session.runId), inArray(remoteSessions.status, ['opening', 'connected', 'idle'])))
        .orderBy(desc(remoteSessions.lastActivityAt))
        .limit(1)
      if (remoteRow) {
        const eventRows = remoteRow.kind === 'terminal'
          ? await app.db
              .select({ id: remoteSessionEvents.id, seq: remoteSessionEvents.seq, detail: remoteSessionEvents.detail, at: remoteSessionEvents.at })
              .from(remoteSessionEvents)
              .where(eq(remoteSessionEvents.sessionId, remoteRow.sessionId))
              .orderBy(desc(remoteSessionEvents.seq))
              .limit(100)
          : []
        const ordered = eventRows.reverse()
        const entries = ordered.flatMap<TerminalSurfaceEntry>((event) => {
          if (event.detail.kind === 'command_started') {
            return [{ id: event.id, kind: 'command', prompt: '$', text: event.detail.command, at: event.at.toISOString() }]
          }
          if (event.detail.kind === 'command_output') {
            return [{ id: event.id, kind: event.detail.stream, text: event.detail.text, at: event.at.toISOString() }]
          }
          return []
        })
        const started = [...ordered].reverse().find((event) => event.detail.kind === 'command_started')
        const completed = [...ordered].reverse().find((event) => event.detail.kind === 'command_completed')
        remote = {
          ...remoteRow,
          atMs: Math.max(0, remoteRow.lastActivityAt.getTime() - startedAtMs),
          terminal: remoteRow.kind === 'terminal'
            ? {
                entries,
                status: started && (!completed || completed.seq < started.seq)
                  ? 'running'
                  : completed?.detail.kind === 'command_completed' && completed.detail.exitCode !== 0
                    ? 'failed'
                    : entries.length ? 'completed' : 'idle',
              }
            : null,
        }
      }
    }
    return { status: session.status, turns, activity, browser, terminal, remote }
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
