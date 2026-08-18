import 'server-only'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  browserSessions,
  browserSteps,
  callSessions,
  chatThreads,
  deskEvents,
  deskSessions,
  files,
  runEvents,
  runs,
  remoteComputers,
  remoteSessionEvents,
  remoteSessions,
} from '../db/schema'
import { db } from '../db/client'
import { conversationIdFor } from './chat-threads'
import type { TerminalSurfaceEntry } from '@braedonsaunders/appkit-remote-sessions/react'

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

export type ChatWorkHistoryEvent = {
  id: string
  runId: string
  seq: number
  kind: string
  label: string
  at: string
}

export type ChatWorkFile = {
  id: string
  runId: string
  filename: string
  contentType: string
  sizeBytes: number
  kind: string
  createdAt: string
}

export type ChatRemoteWorkSurface = {
  sessionId: string
  runId: string
  computerName: string
  kind: 'computer' | 'terminal'
  protocol: string
  status: string
  lastActivityAt: string
  terminal: {
    title: string
    subtitle: string
    cwd: string | null
    status: 'idle' | 'running' | 'failed' | 'completed'
    entries: TerminalSurfaceEntry[]
  } | null
}

export type ChatBrowserWorkSurface = {
  kind: 'browser'
  runId: string
  status: string
  frame: { fileId: string | null; title: string; url: string | null; action: string; at: string }
}

export type ChatTerminalWorkSurface = {
  kind: 'terminal'
  runId: string
  status: string
  terminal: {
    title: string
    subtitle: string
    cwd: string | null
    status: 'idle' | 'running' | 'failed' | 'completed'
    entries: TerminalSurfaceEntry[]
    lastActivityAt: string
  }
}

export type ChatWorkSurface = {
  history: ChatWorkHistoryEvent[]
  remote: ChatRemoteWorkSurface | null
  recentBrowser: ChatBrowserWorkSurface | null
  recentTerminal: ChatTerminalWorkSurface | null
  files: ChatWorkFile[]
} & (
  | { kind: 'idle'; runId: null }
  | { kind: 'desktop'; runId: string; status: string }
  | ChatTerminalWorkSurface
  | ChatBrowserWorkSurface
  | { kind: 'call'; runId: string; sessionId: string; room: string; status: string; direction: string; startedAt: string }
  | {
      kind: 'activity'
      runId: string
      status: string
      events: ChatWorkHistoryEvent[]
    }
)

function eventLabel(kind: string, payload: Record<string, unknown>): string {
  if (kind === 'tool_call') return `Using ${String(payload.toolName ?? 'a connected tool').replaceAll('_', ' ')}`
  if (kind === 'tool_result') return `${String(payload.toolName ?? 'Tool').replaceAll('_', ' ')} finished`
  if (kind === 'approval_request') return String(payload.description ?? 'Waiting for approval')
  if (kind === 'error') return String(payload.message ?? 'A step did not finish')
  return kind.replaceAll('_', ' ')
}

/** Resolve the live surface and durable execution history for one conversation. */
export async function chatWorkSurface(tenantId: string, threadId: string): Promise<ChatWorkSurface> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [thread] = await app.db.select({ id: chatThreads.id }).from(chatThreads).where(eq(chatThreads.id, threadId)).limit(1)
    if (!thread) return { kind: 'idle', runId: null, history: [], remote: null, recentBrowser: null, recentTerminal: null, files: [] }
    const threadRuns = await app.db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(sql`${runs.trigger}->>'conversationId' = ${conversationIdFor(threadId)}`)
      .orderBy(desc(runs.startedAt))
      .limit(100)
    const run = threadRuns[0]
    if (!run) return { kind: 'idle', runId: null, history: [], remote: null, recentBrowser: null, recentTerminal: null, files: [] }

    const conversationFiles = await app.db
      .select({
        id: files.id,
        runId: files.runId,
        filename: files.filename,
        contentType: files.contentType,
        sizeBytes: files.sizeBytes,
        kind: files.kind,
        createdAt: files.createdAt,
      })
      .from(files)
      .where(
        and(
          inArray(files.runId, threadRuns.map((candidate) => candidate.id)),
          // Screen and call recordings are evidence presented on History and
          // the visual surfaces. Files is the employee's actual work product.
          inArray(files.kind, ['document', 'spreadsheet', 'attachment', 'upload']),
        ),
      )
      .orderBy(desc(files.createdAt))
      .limit(100)
    const workFiles: ChatWorkFile[] = conversationFiles.flatMap((file) =>
      file.runId
        ? [{ ...file, runId: file.runId, createdAt: file.createdAt.toISOString() }]
        : [],
    )

    // A chat thread is one durable conversation even though each user turn is
    // executed as its own run. Reading only the newest run made the old Live
    // work panel erase itself at the start of every turn. Keep the complete
    // conversation-facing step history here; the immutable run record remains
    // the source of full inputs and results.
    const historyRows = await app.db
      .select({
        id: runEvents.id,
        runId: runEvents.runId,
        seq: runEvents.seq,
        kind: runEvents.kind,
        payload: runEvents.payload,
        at: runEvents.createdAt,
      })
      .from(runEvents)
      .where(
        and(
          inArray(runEvents.runId, threadRuns.map((candidate) => candidate.id)),
          inArray(runEvents.kind, ['tool_call', 'approval_request', 'delegation', 'error', 'procedure_citation', 'trace']),
        ),
      )
      .orderBy(desc(runEvents.createdAt), desc(runEvents.id))
      .limit(200)
    const history = historyRows
      .map((event) => ({
        id: event.id,
        runId: event.runId,
        seq: event.seq,
        kind: event.kind,
        label: eventLabel(event.kind, event.payload),
        at: event.at.toISOString(),
      }))
      .reverse()

    // The stage is durable across turns. Keep the last graphical browser and
    // shell ledger available after the live run closes and after a page reload.
    const recentDeskRows = await app.db
      .select({
        sessionId: deskSessions.id,
        runId: deskSessions.runId,
        sessionStatus: deskSessions.status,
        seq: deskEvents.seq,
        kind: deskEvents.kind,
        detail: deskEvents.detail,
        screenshotFileId: deskEvents.screenshotFileId,
        at: deskEvents.at,
      })
      .from(deskEvents)
      .innerJoin(deskSessions, eq(deskSessions.id, deskEvents.sessionId))
      .where(inArray(deskSessions.runId, threadRuns.map((candidate) => candidate.id)))
      .orderBy(desc(deskEvents.at), desc(deskEvents.seq))
      .limit(200)
    const recentBrowserRow = recentDeskRows.find((event) => isBrowserDeskEvent(event.kind, event.detail)) ?? null
    let recentBrowser: ChatBrowserWorkSurface | null = recentBrowserRow
      ? {
          kind: 'browser',
          runId: recentBrowserRow.runId,
          status: recentBrowserRow.sessionStatus,
          frame: {
            fileId: recentBrowserRow.screenshotFileId,
            title: recentBrowserRow.detail.title ?? recentBrowserRow.detail.url ?? 'Browser',
            url: recentBrowserRow.detail.url ?? null,
            action: recentBrowserRow.detail.target ? `${recentBrowserRow.kind}: ${recentBrowserRow.detail.target}` : recentBrowserRow.kind,
            at: recentBrowserRow.at.toISOString(),
          },
        }
      : null
    if (!recentBrowser) {
      const [legacy] = await app.db
        .select({
          runId: browserSessions.runId,
          status: browserSessions.status,
          fileId: browserSteps.screenshotFileId,
          action: browserSteps.action,
          detail: browserSteps.detail,
          at: browserSteps.at,
        })
        .from(browserSteps)
        .innerJoin(browserSessions, eq(browserSessions.id, browserSteps.sessionId))
        .where(inArray(browserSessions.runId, threadRuns.map((candidate) => candidate.id)))
        .orderBy(desc(browserSteps.at), desc(browserSteps.seq))
        .limit(1)
      if (legacy) {
        recentBrowser = {
          kind: 'browser',
          runId: legacy.runId,
          status: legacy.status,
          frame: {
            fileId: legacy.fileId,
            title: legacy.detail.title ?? legacy.detail.url ?? 'Browser',
            url: legacy.detail.url ?? null,
            action: legacy.detail.target ? `${legacy.action}: ${legacy.detail.target}` : legacy.action,
            at: legacy.at.toISOString(),
          },
        }
      }
    }
    const recentShellRow = recentDeskRows.find((event) => event.kind === 'shell_command') ?? null
    const shellRows = recentShellRow
      ? recentDeskRows
          .filter((event) => event.sessionId === recentShellRow.sessionId && event.kind === 'shell_command')
          .slice(0, 20)
          .reverse()
      : []
    const recentTerminal: ChatTerminalWorkSurface | null = recentShellRow
      ? {
          kind: 'terminal',
          runId: recentShellRow.runId,
          status: recentShellRow.sessionStatus,
          terminal: {
            title: 'Desk terminal',
            subtitle: 'The agent’s machine · recorded command surface',
            cwd: recentShellRow.detail.cwd ?? null,
            status: recentShellRow.detail.exitCode === 0 ? 'completed' : 'failed',
            lastActivityAt: recentShellRow.at.toISOString(),
            entries: shellRows.flatMap<TerminalSurfaceEntry>((event) => {
              const command: TerminalSurfaceEntry = {
                id: `${event.sessionId}:${event.seq}:command`,
                kind: 'command',
                prompt: `${event.detail.cwd ?? '~'} $`,
                text: event.detail.command ?? '',
                at: event.at.toISOString(),
              }
              const output = event.detail.output?.trim()
              return output ? [command, {
                id: `${event.sessionId}:${event.seq}:output`,
                kind: event.detail.exitCode === 0 ? 'stdout' : 'stderr',
                text: `${output}${event.detail.outputTruncated ? '\n[output truncated]' : ''}`,
                at: event.at.toISOString(),
              }] : [command]
            }),
          },
        }
      : null
    const retained = { history, recentBrowser, recentTerminal, files: workFiles }

    const [remoteRow] = await app.db
      .select({
        sessionId: remoteSessions.id,
        runId: remoteSessions.runId,
        computerName: remoteComputers.name,
        kind: remoteSessions.kind,
        protocol: remoteSessions.protocol,
        status: remoteSessions.status,
        lastActivityAt: remoteSessions.lastActivityAt,
      })
      .from(remoteSessions)
      .innerJoin(remoteComputers, eq(remoteComputers.id, remoteSessions.computerId))
      .where(and(
        inArray(remoteSessions.runId, threadRuns.map((candidate) => candidate.id)),
        inArray(remoteSessions.status, ['opening', 'connected', 'idle']),
      ))
      .orderBy(desc(remoteSessions.lastActivityAt))
      .limit(1)
    const remoteEventRows = remoteRow?.kind === 'terminal'
      ? await app.db
          .select({ id: remoteSessionEvents.id, seq: remoteSessionEvents.seq, kind: remoteSessionEvents.kind, detail: remoteSessionEvents.detail, at: remoteSessionEvents.at })
          .from(remoteSessionEvents)
          .where(eq(remoteSessionEvents.sessionId, remoteRow.sessionId))
          .orderBy(desc(remoteSessionEvents.seq))
          .limit(100)
      : []
    const remoteEntries = remoteEventRows.reverse().flatMap<TerminalSurfaceEntry>((event) => {
      if (event.detail.kind === 'command_started') {
        return [{ id: event.id, kind: 'command', prompt: '$', text: event.detail.command, at: event.at.toISOString() }]
      }
      if (event.detail.kind === 'command_output') {
        return [{ id: event.id, kind: event.detail.stream, text: event.detail.text, at: event.at.toISOString() }]
      }
      return []
    })
    const completedRemoteCommand = [...remoteEventRows].reverse().find((event) => event.detail.kind === 'command_completed')
    const startedRemoteCommand = [...remoteEventRows].reverse().find((event) => event.detail.kind === 'command_started')
    const remote = remoteRow ? {
      ...remoteRow,
      lastActivityAt: remoteRow.lastActivityAt.toISOString(),
      terminal: remoteRow.kind === 'terminal'
        ? {
            title: `${remoteRow.computerName} terminal`,
            subtitle: `${remoteRow.protocol.toUpperCase()} · durable remote session`,
            cwd: null,
            status: startedRemoteCommand && (!completedRemoteCommand || completedRemoteCommand.seq < startedRemoteCommand.seq)
              ? 'running' as const
              : completedRemoteCommand?.detail.kind === 'command_completed' && completedRemoteCommand.detail.exitCode !== 0
                ? 'failed' as const
                : 'completed' as const,
            entries: remoteEntries,
          }
        : null,
    } : null

    const [call] = await app.db
      .select({ id: callSessions.id, room: callSessions.room, status: callSessions.status, direction: callSessions.direction, startedAt: callSessions.startedAt })
      .from(callSessions)
      .where(and(eq(callSessions.runId, run.id), eq(callSessions.status, 'active')))
      .orderBy(desc(callSessions.startedAt))
      .limit(1)

    // A live call owns the conversational stage. Browser or desktop work on
    // that call arrives inside it as the agent-screen track, preserving the
    // people and speaking state alongside what the agent is doing.
    if (call) {
      return {
        kind: 'call',
        runId: run.id,
        sessionId: call.id,
        room: call.room,
        status: call.status,
        direction: call.direction,
        startedAt: call.startedAt.toISOString(),
        ...retained,
        remote,
      }
    }

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

    if (desk?.status === 'active' && latestDeskEvent?.kind === 'shell_command') {
      const shellRows = await app.db
        .select({ seq: deskEvents.seq, detail: deskEvents.detail, at: deskEvents.at })
        .from(deskEvents)
        .where(and(eq(deskEvents.sessionId, desk.id), eq(deskEvents.kind, 'shell_command')))
        .orderBy(desc(deskEvents.seq))
        .limit(20)
      const ordered = shellRows.reverse()
      const latest = ordered.at(-1)
      const entries: TerminalSurfaceEntry[] = ordered.flatMap((event) => {
        const command: TerminalSurfaceEntry = {
          id: `${desk.id}:${event.seq}:command`,
          kind: 'command',
          prompt: `${event.detail.cwd ?? '~'} $`,
          text: event.detail.command ?? '',
          at: event.at.toISOString(),
        }
        const output = event.detail.output?.trim()
        return output
          ? [command, {
              id: `${desk.id}:${event.seq}:output`,
              kind: event.detail.exitCode === 0 ? 'stdout' as const : 'stderr' as const,
              text: `${output}${event.detail.outputTruncated ? '\n[output truncated]' : ''}`,
              at: event.at.toISOString(),
            }]
          : [command]
      })
      return {
        kind: 'terminal',
        runId: run.id,
        status: run.status,
        terminal: {
          title: 'Desk terminal',
          subtitle: 'The agent’s machine · live command record',
          cwd: latest?.detail.cwd ?? null,
          status: latest?.detail.exitCode === 0 ? 'completed' : 'failed',
          entries,
          lastActivityAt: latest?.at.toISOString() ?? new Date().toISOString(),
        },
        ...retained,
        remote,
      }
    }

    if (
      desk?.status === 'active' &&
      latestDeskEvent &&
      isBrowserDeskEvent(latestDeskEvent.kind, latestDeskEvent.detail)
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
        ...retained,
        remote,
      }
    }

    if (desk?.status === 'active' && latestScreenBoundary?.kind === 'screen_open') {
      return { kind: 'desktop', runId: run.id, status: run.status, ...retained, remote }
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
      if (step && browser.status === 'active') {
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
          ...retained,
          remote,
        }
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
    const events = latestDeskEvents.length
      ? latestDeskEvents
          .map((event) => ({
            id: `${run.id}:desk:${event.seq}`,
            runId: run.id,
            seq: event.seq,
            kind: event.kind,
            label: eventLabel(event.kind, event.detail),
            at: event.at.toISOString(),
          }))
          .reverse()
      : history
    return { kind: 'activity', runId: run.id, status: run.status, events, ...retained, remote }
  })
}
