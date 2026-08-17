'use client'

import * as React from 'react'
import Link from 'next/link'
import { Loader2, MessageSquarePlus, Monitor, PanelRightClose } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Drawer,
  EmptyState,
  Label,
  PageHeader,
  Select,
  cn,
} from '@appkit/ui'
import { AgentPanel, type AgentMessage } from '@appkit/ai/react'
import { getThreadAction, listThreadsAction, startThreadAction } from '../app/chat/actions'
import { ChatDesk } from './chat-desk'

/**
 * Chat: talk to an agent, and watch the machine it is working on while it
 * answers. The thread and its composer are @appkit/ai's AgentPanel — this app
 * owns persistence, the transport, and everything around the thread; appkit
 * owns the streaming decode, cancellation, and the ordered rendering of an
 * assistant turn's parts. The desk beside it is the half no panel can supply.
 *
 * Nothing said here is a second channel: a chat turn is a run like any other,
 * so every turn's run record is one click away and the whole conversation
 * replays in the observatory.
 */

export type ChatThreadSummary = {
  id: string
  title: string
  personId: string
  personName: string
  /** ISO — the ledger's own stamp, formatted where it is read. */
  lastMessageAt: string
  status: string
}

/** One persisted turn. */
export type ChatMessageRecord = {
  id: string
  seq: number
  role: string
  body: string
  at: string
  runId: string | null
}

export type ChatThreadDetail = {
  thread: { id: string; title: string; personId: string; personName: string; status: string }
  messages: ChatMessageRecord[]
}

/** An agent that can be talked to — one that has a brain assigned to think with. */
export type ChatAgentOption = { id: string; name: string; title: string }

/** The width at which the desk can sit beside the conversation — Tailwind's `lg`. */
const WIDE_VIEWPORT = '(min-width: 1024px)'

function subscribeToWidth(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE_VIEWPORT)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/**
 * Whether there is room for three columns. The server renders as though there
 * is — this is a desk surface, and that is where it is used — and the first
 * client render corrects it, which keeps the desk from flashing open on a
 * phone rather than flashing shut on a laptop.
 */
function useWideViewport(): boolean {
  return React.useSyncExternalStore(
    subscribeToWidth,
    () => window.matchMedia(WIDE_VIEWPORT).matches,
    () => true,
  )
}

/**
 * A persisted turn as the panel wants it. The panel's own renderer reads a
 * `text` part for both sides, so a stored body becomes exactly one of those;
 * a streamed turn arrives with the richer parts (tool cards, steps) already
 * shaped by the SDK and is left alone.
 */
function toAgentMessage(message: ChatMessageRecord): AgentMessage {
  return {
    id: message.id,
    role: message.role === 'user' ? 'user' : message.role === 'system' ? 'system' : 'assistant',
    parts: [{ type: 'text', text: message.body }],
  }
}

function stampLabel(value: string): string {
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * A timestamp in the reader's own zone. The server renders it in the server's,
 * which is the one thing about it that is certainly wrong — so the mismatch is
 * declared rather than fought, and the client's render is the one that stands.
 */
function Stamp({ at }: { at: string }) {
  return <span suppressHydrationWarning>{stampLabel(at)}</span>
}

/** The runs a conversation produced, newest first, with nothing listed twice. */
function runsOf(messages: ChatMessageRecord[]): { runId: string; at: string }[] {
  const seen = new Set<string>()
  const runs: { runId: string; at: string }[] = []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message?.runId || seen.has(message.runId)) continue
    seen.add(message.runId)
    runs.push({ runId: message.runId, at: message.at })
  }
  return runs
}

/**
 * The record under the thread: the runs this conversation produced, and any
 * note the system put on it.
 *
 * Both belong here rather than in the thread itself. A run is the evidence for
 * a turn, and the panel renders an assistant turn's own parts — so the link to
 * the full record hangs off the conversation instead of being buried in a
 * bubble. System notes are on the thread but are not something anyone said,
 * and the panel does not render them; they are the conversation's margin, and
 * this is the margin.
 */
function ThreadRecordBar({ messages }: { messages: ChatMessageRecord[] }) {
  const runs = runsOf(messages)
  const notes = messages.filter((message) => message.role === 'system')
  if (runs.length === 0 && notes.length === 0) return null
  return (
    <div className="shrink-0 space-y-2 border-b border-border px-4 py-2.5">
      {notes.length > 0 ? (
        <ul className="space-y-0.5">
          {notes.slice(-3).map((note) => (
            <li key={note.id} className="text-xs text-fg-muted">
              {note.body}
            </li>
          ))}
        </ul>
      ) : null}
      {runs.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-xs text-fg-muted">Run records:</span>
          {runs.slice(0, 8).map((run) => (
            <Button key={run.runId} asChild size="sm" variant="outline" className="h-6 px-2 text-xs">
              <Link href={`/runs/${run.runId}`}>
                <Stamp at={run.at} />
              </Link>
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** The conversations, newest first — navigation, so a list rather than a table. */
function ThreadList({
  threads,
  activeId,
  avatars,
  onSelect,
  onNew,
  canStart,
}: {
  threads: ChatThreadSummary[]
  activeId: string | null
  avatars: Record<string, React.ReactNode>
  onSelect: (id: string) => void
  onNew: () => void
  canStart: boolean
}) {
  return (
    <Card className="flex h-full min-h-0 flex-col">
      <CardHeader className="shrink-0 flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">Conversations</CardTitle>
        {canStart ? (
          <Button type="button" size="sm" variant="outline" onClick={onNew}>
            <MessageSquarePlus aria-hidden className="size-4" />
            New
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="app-scroll min-h-0 flex-1 overflow-y-auto max-lg:max-h-64">
        {threads.length === 0 ? (
          <p className="py-6 text-sm text-fg-muted">
            No conversations yet. Start one and it appears here, alongside the run record it produces.
          </p>
        ) : (
          <ul className="space-y-1">
            {threads.map((thread) => (
              <li key={thread.id}>
                <button
                  type="button"
                  aria-current={thread.id === activeId ? 'true' : undefined}
                  onClick={() => onSelect(thread.id)}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors',
                    thread.id === activeId ? 'bg-primary-subtle' : 'hover:bg-surface-hover',
                  )}
                >
                  <span className="mt-0.5 shrink-0">{avatars[thread.personId] ?? null}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-fg">{thread.title}</span>
                    <span className="block truncate text-xs text-fg-muted">
                      {thread.personName} · <Stamp at={thread.lastMessageAt} />
                    </span>
                  </span>
                  {thread.status === 'closed' ? (
                    <Badge variant="outline" className="shrink-0">
                      closed
                    </Badge>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

export function ChatWorkspace({
  threads: initialThreads,
  agents,
  avatars,
  initialThread,
}: {
  threads: ChatThreadSummary[]
  /** The agents that can hold a conversation — the roster, already filtered. */
  agents: ChatAgentOption[]
  /** Each agent's face, rendered on the server so this pane carries no part library. */
  avatars: Record<string, React.ReactNode>
  /** The thread named in the URL, already loaded, or null. */
  initialThread: ChatThreadDetail | null
}) {
  const [threads, setThreads] = React.useState(initialThreads)
  const [detail, setDetail] = React.useState<ChatThreadDetail | null>(initialThread)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [composing, setComposing] = React.useState(false)
  const [deskChoice, setDeskChoice] = React.useState<boolean | null>(null)

  const wide = useWideViewport()
  // One preference, resolved against the viewport: untouched, the desk is
  // beside the conversation where there is room for it and folded away where
  // there is not. Once someone has said which they want, that stands.
  const deskOpen = deskChoice ?? wide

  const activeId = detail?.thread.id ?? null

  const load = React.useCallback(async (threadId: string) => {
    setLoading(true)
    setError(null)
    try {
      const loaded = await getThreadAction(threadId)
      if (loaded === null) {
        setError('That conversation is no longer here.')
        return
      }
      setDetail(loaded)
      // The URL follows the thread without a navigation: a soft navigation
      // here would re-render the page from the server and take the panel's
      // live stream with it.
      window.history.replaceState(null, '', `/chat?thread=${encodeURIComponent(threadId)}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'That conversation could not be opened.')
    } finally {
      setLoading(false)
    }
  }, [])

  /**
   * What the pane learns after a turn: the run the turn produced, and where
   * the conversation now sits in the list. Refreshed rather than guessed —
   * the run id is written by the run, not by anything here.
   */
  const refreshAfterTurn = React.useCallback(async (threadId: string) => {
    try {
      const [loaded, list] = await Promise.all([getThreadAction(threadId), listThreadsAction()])
      setThreads(list)
      if (loaded === null) return
      // Only the record around the thread is taken: the panel holds the turn
      // that has just streamed, in far more detail than the stored bodies.
      setDetail((current) => (current && current.thread.id === threadId ? loaded : current))
    } catch {
      // The list simply stays as it was; nothing the reader did has been lost.
    }
  }, [])

  const send = React.useCallback(
    async (prompt: string, signal: AbortSignal): Promise<Response> => {
      const threadId = activeId
      if (threadId === null) throw new Error('No conversation is open.')
      const response = await fetch(`/api/chat/${encodeURIComponent(threadId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
        signal,
      })
      // The panel owns the stream; reading a clone alongside it is how this
      // pane learns the turn is over — without it the run link and the list's
      // ordering would sit stale until the next navigation.
      void response
        .clone()
        .text()
        .then(() => refreshAfterTurn(threadId))
        .catch(() => undefined)
      return response
    },
    [activeId, refreshAfterTurn],
  )

  /**
   * A conversation starts empty and its first turn streams like every other
   * one — the action's documented empty-body path. Anything else would take
   * the opening message down a second road to the same run.
   */
  const startThread = React.useCallback(
    async (personId: string) => {
      const started = await startThreadAction(personId, '')
      setComposing(false)
      const list = await listThreadsAction().catch(() => threads)
      setThreads(list)
      await load(started.threadId)
    },
    [load, threads],
  )

  const conversation = (
    <Card className="flex h-full min-h-0 flex-col overflow-hidden max-lg:min-h-[28rem]">
      {detail === null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          {loading ? (
            <span className="flex items-center gap-2 text-sm text-fg-muted">
              <Loader2 aria-hidden className="size-4 animate-spin" />
              Opening the conversation…
            </span>
          ) : (
            <EmptyState
              title={threads.length === 0 ? 'No conversations yet' : 'Pick a conversation'}
              description={
                agents.length === 0
                  ? 'No agent on the roster has a model assigned yet, so there is nobody here to talk to. Assign one from an agent’s profile.'
                  : threads.length === 0
                    ? 'Start one with any agent. What you agree here becomes a run on their record, the same as an email would.'
                    : 'Choose a conversation on the left, or start a new one.'
              }
              action={
                agents.length === 0 ? (
                  <Button asChild size="sm" variant="outline">
                    <Link href="/organization">Open the roster</Link>
                  </Button>
                ) : (
                  <Button type="button" size="sm" onClick={() => setComposing(true)}>
                    <MessageSquarePlus aria-hidden className="size-4" />
                    New conversation
                  </Button>
                )
              }
            />
          )}
        </div>
      ) : (
        <>
          <ThreadRecordBar messages={detail.messages} />
          <AgentPanel
            // Keyed by the thread: the panel seeds its transcript once, so a
            // different conversation has to be a different panel.
            key={detail.thread.id}
            enabled
            initialMessages={detail.messages.map(toAgentMessage)}
            send={send}
            labels={{
              title: `${detail.thread.personName} · ${detail.thread.title}`,
              welcomeTitle: `Ask ${detail.thread.personName} for something`,
              welcomeDescription:
                'Anything they do lands on their run record, and on their desk if the work needs one.',
              placeholder: `Message ${detail.thread.personName}…`,
              failed:
                'That turn did not finish. Nothing has been lost — ask again, or open the run record to see how far it got.',
            }}
          />
        </>
      )}
    </Card>
  )

  return (
    <div className="app-scroll min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">
      <div className="mx-auto flex w-full max-w-(--breakpoint-2xl) flex-col gap-4 p-4 sm:p-6 lg:h-full">
        <PageHeader
          className="shrink-0"
          title="Chat"
          description="Talk to an agent and watch it work. Every turn is a run on their record."
          actions={
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={deskOpen}
              onClick={() => setDeskChoice(!deskOpen)}
            >
              {deskOpen ? (
                <PanelRightClose aria-hidden className="size-4" />
              ) : (
                <Monitor aria-hidden className="size-4" />
              )}
              {deskOpen ? 'Hide desk' : 'Show desk'}
            </Button>
          }
        />

        {error !== null ? (
          <p role="alert" className="shrink-0 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div
          className={cn(
            'grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-rows-[minmax(0,1fr)]',
            deskOpen
              ? 'lg:grid-cols-[14rem_minmax(0,1fr)_minmax(0,22rem)] xl:grid-cols-[15rem_minmax(0,1fr)_minmax(0,28rem)]'
              : 'lg:grid-cols-[15rem_minmax(0,1fr)]',
          )}
        >
          <ThreadList
            threads={threads}
            activeId={activeId}
            avatars={avatars}
            onSelect={(id) => void load(id)}
            onNew={() => setComposing(true)}
            canStart={agents.length > 0}
          />
          {conversation}
          {/* Unmounted rather than hidden when it is folded away: a pane that
              is not on screen must not be holding a frame stream open. */}
          {deskOpen && detail !== null ? (
            <div className="min-h-0 max-lg:h-[34rem]">
              {/* Keyed on the agent: a different desk is a different machine,
                  and none of what was true about the last one — its screen,
                  its frames, who was driving it — carries over. */}
              <ChatDesk
                key={detail.thread.personId}
                personId={detail.thread.personId}
                personName={detail.thread.personName}
              />
            </div>
          ) : null}
        </div>
      </div>

      <NewConversationDrawer
        open={composing}
        agents={agents}
        onClose={() => setComposing(false)}
        onStart={startThread}
      />
    </div>
  )
}

/**
 * Starting a conversation is choosing who it is with. The first thing said is
 * said in the thread itself, where every later turn is said — one road to the
 * run, and the opening message streams like the rest of them.
 */
function NewConversationDrawer({
  open,
  agents,
  onClose,
  onStart,
}: {
  open: boolean
  agents: ChatAgentOption[]
  onClose: () => void
  onStart: (personId: string) => Promise<void>
}) {
  const [personId, setPersonId] = React.useState(agents[0]?.id ?? '')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const submit = async () => {
    if (personId === '') return
    setBusy(true)
    setError(null)
    try {
      await onStart(personId)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'That conversation could not be started.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="New conversation"
      description="Pick who you are talking to. What you ask for becomes a run on their record."
      size="md"
      footer={
        <div className="flex items-center gap-2">
          <Button type="button" disabled={busy || personId === ''} onClick={() => void submit()}>
            {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
            Start the conversation
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="chat-agent">Agent</Label>
          <Select id="chat-agent" value={personId} onChange={(event) => setPersonId(event.target.value)}>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name} — {agent.title}
              </option>
            ))}
          </Select>
          <p className="text-xs text-fg-muted">
            Only agents with a model assigned are listed — the rest have nothing to think with yet.
          </p>
        </div>
        {error !== null ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Drawer>
  )
}
