'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Download,
  GitBranch,
  Loader2,
  MessageSquarePlus,
  Monitor,
  MoreHorizontal,
  PanelRightClose,
  Pencil,
  Phone,
  Plus,
  Search,
  X,
} from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  ContextMenu,
  EmptyState,
  Input,
  Popover,
  cn,
  promptDialog,
  useContextMenu,
  type ContextMenuEntry,
} from '@braedonsaunders/appkit-ui'
import {
  AgentPanel,
  type AgentMessage,
  type AgentQueuedMessage,
} from '@braedonsaunders/appkit-ai/react'
import { ComposedAvatar } from '@braedonsaunders/appkit-avatars/react'
import {
  getThreadAction,
  continueThreadAction,
  editQueuedMessageAction,
  enqueueMessageAction,
  listThreadsAction,
  removeQueuedMessageAction,
  renameThreadAction,
  retryQueuedMessageAction,
  setThreadStatusAction,
  startThreadAction,
} from '../app/chat/actions'
import { ChatWorkSurface } from './chat-work-surface'
import { CALL_STAGE_AVATAR_SIZE } from './call-stage'
import { ConversationCall, type AgentAvatar } from './call-room'

/**
 * Chat: talk to an agent, and watch the machine it is working on while it
 * answers. The thread and its composer are @braedonsaunders/appkit-ai's AgentPanel — this app
 * owns persistence, the transport, and everything around the thread; appkit
 * owns the streaming decode, cancellation, and the ordered rendering of an
 * assistant turn's parts. The desk beside it is the half no panel can supply.
 *
 * Nothing said here is a second channel: a chat turn is a run like any other.
 * The conversation stays about what was said; execution evidence lives in the
 * adjacent History surface and the observatory instead of accumulating as
 * internal run pills above the transcript.
 */

/** `closed` is archived: out of the default list, still entirely on the record. */
export type ChatThreadStatus = 'open' | 'closed'

export type ChatThreadSummary = {
  id: string
  title: string
  personId: string
  personName: string
  /** ISO — the ledger's own stamp, formatted where it is read. */
  lastMessageAt: string
  status: ChatThreadStatus
  originThreadId: string | null
  originMessageSeq: number | null
}

/** One persisted turn. */
export type ChatMessageRecord = {
  id: string
  seq: number
  role: string
  body: string
  at: string
  runId: string | null
  dispatchId: string | null
}

export type ChatDispatchRecord = {
  id: string
  threadId: string
  userId: string
  position: number
  body: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  attempts: number
  runId: string | null
  lastError: string | null
  queuedAt: string
  claimedAt: string | null
  finishedAt: string | null
}

export type ChatThreadDetail = {
  thread: {
    id: string
    title: string
    personId: string
    personName: string
    status: ChatThreadStatus
    originThreadId: string | null
    originMessageSeq: number | null
  }
  messages: ChatMessageRecord[]
  dispatches: ChatDispatchRecord[]
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

function ConversationWelcome({ agent, avatar }: { agent: ChatAgentOption; avatar: AgentAvatar }) {
  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center overflow-hidden px-5 py-6 text-center">
      <div className="bh-call-enter relative">
        <div aria-hidden className="absolute inset-8 rounded-full bg-primary-subtle blur-3xl" />
        {avatar.composition ? (
          <ComposedAvatar
            composition={avatar.composition}
            parts={avatar.parts}
            categories={avatar.categories}
            variant="head"
            size={CALL_STAGE_AVATAR_SIZE}
            rounded
            animate="idle"
            name={agent.name}
          />
        ) : (
          <div
            role="img"
            aria-label={agent.name}
            style={{ width: CALL_STAGE_AVATAR_SIZE, height: CALL_STAGE_AVATAR_SIZE }}
            className="relative flex items-center justify-center rounded-full border border-border bg-primary-subtle text-primary shadow-sm"
          >
            <span className="text-8xl font-semibold">{agent.name.charAt(0).toUpperCase()}</span>
          </div>
        )}
      </div>
      <h2 className="mt-4 text-lg font-semibold text-fg">Ask {agent.name} for something</h2>
      <p className="mt-1 max-w-md text-sm leading-relaxed text-fg-muted">
        Talk naturally. Their browser, desktop, terminal, files, and complete work history stay visible beside the conversation.
      </p>
    </div>
  )
}

/**
 * System notes are on the thread but are not something anyone said, and the
 * panel does not render them. Keep the few newest notes in the conversation's
 * margin; run boundaries belong in History, where the underlying work is both
 * named and actionable.
 *
 * This bar disappears entirely in the ordinary case, preserving the maximum
 * height for the transcript.
 */
function ThreadNoticeBar({ messages }: { messages: ChatMessageRecord[] }) {
  const notes = messages.filter((message) => message.role === 'system')
  if (notes.length === 0) return null
  return (
    <div className="shrink-0 border-b border-border px-4 py-2">
      <ul className="space-y-0.5">
        {notes.slice(-3).map((note) => (
          <li key={note.id} className="text-xs text-fg-muted">
            {note.body}
          </li>
        ))}
      </ul>
    </div>
  )
}

function ContinuationNotice({ originThreadId, onOpen }: { originThreadId: string | null; onOpen: (id: string) => void }) {
  if (!originThreadId) return null
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface-hover px-4 py-2 text-xs text-fg-muted">
      <span className="flex min-w-0 items-center gap-2">
        <GitBranch aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">Continued from an earlier conversation</span>
      </span>
      <button type="button" className="shrink-0 font-medium text-primary hover:underline" onClick={() => onOpen(originThreadId)}>
        Open earlier
      </button>
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
  onNewCall,
  canStart,
  canCall,
  showArchived,
  onShowArchived,
  onRename,
  onSetStatus,
  onContinue,
  onExport,
  query,
  onQueryChange,
}: {
  threads: ChatThreadSummary[]
  activeId: string | null
  avatars: Record<string, React.ReactNode>
  onSelect: (id: string) => void
  onNew: () => void
  onNewCall: () => void
  canStart: boolean
  canCall: boolean
  showArchived: boolean
  onShowArchived: (next: boolean) => void
  onRename: (thread: ChatThreadSummary) => void
  onSetStatus: (thread: ChatThreadSummary, status: ChatThreadStatus) => void
  onContinue: (thread: ChatThreadSummary) => void
  onExport: (thread: ChatThreadSummary, format: 'md' | 'json') => void
  query: string
  onQueryChange: (query: string) => void
}) {
  // One menu for the whole list, opened against whichever row asked for it —
  // `useContextMenu` is a hook, so a controller per row is not a thing that can
  // exist inside the map.
  const menu = useContextMenu()
  const [creationMenuOpen, setCreationMenuOpen] = React.useState(false)
  const [target, setTarget] = React.useState<ChatThreadSummary | null>(null)

  const openMenuFor = (thread: ChatThreadSummary, open: () => void): void => {
    setTarget(thread)
    open()
  }

  const items: ContextMenuEntry[] =
    target === null
      ? []
      : [
          {
            key: 'rename',
            label: 'Rename…',
            icon: Pencil,
            onSelect: () => onRename(target),
          },
          {
            key: 'continue',
            label: 'Continue in new conversation',
            icon: GitBranch,
            onSelect: () => onContinue(target),
          },
          {
            key: 'export-markdown',
            label: 'Download transcript (.md)',
            icon: Download,
            onSelect: () => onExport(target, 'md'),
          },
          {
            key: 'export-json',
            label: 'Download record (.json)',
            icon: Download,
            onSelect: () => onExport(target, 'json'),
          },
          {
            key: 'status',
            label: target.status === 'closed' ? 'Unarchive' : 'Archive',
            icon: target.status === 'closed' ? ArchiveRestore : Archive,
            onSelect: () => onSetStatus(target, target.status === 'closed' ? 'open' : 'closed'),
          },
        ]

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {/* The same h-12 rule the panel's own header carries, so the three panes
          start on one line across the card. */}
      <header className="flex h-12 shrink-0 items-center justify-end gap-1 border-b border-border bg-surface px-4">
        <span className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant={showArchived ? 'secondary' : 'ghost'}
            className="h-7 px-2"
            aria-pressed={showArchived}
            aria-label={showArchived ? 'Hide archived conversations' : 'Show archived conversations'}
            title={showArchived ? 'Hide archived' : 'Show archived'}
            onClick={() => onShowArchived(!showArchived)}
          >
            {showArchived ? <ArchiveRestore aria-hidden className="size-4" /> : <Archive aria-hidden className="size-4" />}
            {showArchived ? 'Hide archived' : 'Archived'}
          </Button>
          {canStart || canCall ? (
            <Popover
              open={creationMenuOpen}
              onOpenChange={setCreationMenuOpen}
              align="start"
              side="bottom"
              className="min-w-36 p-1"
              trigger={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2"
                  aria-haspopup="menu"
                  aria-expanded={creationMenuOpen}
                  onClick={() => setCreationMenuOpen((open) => !open)}
                >
                  <Plus aria-hidden className="size-4" />
                  New
                  <ChevronDown aria-hidden className="size-3" />
                </Button>
              }
            >
              <div role="menu">
                {[
                  { key: 'chat', label: 'Chat', icon: MessageSquarePlus, onSelect: onNew, disabled: !canStart },
                  { key: 'call', label: 'Call', icon: Phone, onSelect: onNewCall, disabled: !canCall },
                ].map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    role="menuitem"
                    disabled={item.disabled}
                    onClick={() => {
                      setCreationMenuOpen(false)
                      item.onSelect()
                    }}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-sm transition-colors',
                      item.disabled
                        ? 'cursor-not-allowed text-fg-subtle'
                        : 'text-fg hover:bg-surface-hover',
                    )}
                  >
                    <item.icon aria-hidden className="size-4 shrink-0 opacity-80" />
                    <span className="flex-1 truncate">{item.label}</span>
                  </button>
                ))}
              </div>
            </Popover>
          ) : null}
        </span>
      </header>
      <div className="border-b border-border p-2">
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-2 size-4 text-fg-subtle" />
          <Input
            type="search"
            aria-label="Search conversations"
            placeholder="Search conversations…"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            className="h-8 pl-9 pr-8 [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear conversation search"
              onClick={() => onQueryChange('')}
              className="absolute right-2 top-2 text-fg-subtle hover:text-fg"
            >
              <X aria-hidden className="size-4" />
            </button>
          ) : null}
        </div>
      </div>
      <div className="app-scroll min-h-0 flex-1 overflow-y-auto p-2 max-lg:max-h-64">
        {threads.length === 0 ? (
          <p className="py-6 text-sm text-fg-muted">
            {query
              ? 'No conversations match this search.'
              : showArchived
              ? 'No conversations yet. Start one and it appears here, alongside the run record it produces.'
              : 'No open conversations. Start one, or show the archived ones.'}
          </p>
        ) : (
          <ul className="space-y-1">
            {threads.map((thread) => (
              // The row is the menu's target either way — right-click anywhere
              // on it, or the button, which is the same menu somewhere a
              // keyboard can reach. A right-click-only menu is invisible to
              // anyone not using a mouse.
              <li
                key={thread.id}
                className="relative"
                onContextMenu={(event) => openMenuFor(thread, () => menu.onContextMenu(event))}
              >
                <button
                  type="button"
                  aria-current={thread.id === activeId ? 'true' : undefined}
                  onClick={() => onSelect(thread.id)}
                  className={cn(
                    // Room on the right for the actions button, which sits over
                    // the row rather than inside it: a button within a button is
                    // not markup a browser will honour.
                    'flex w-full items-start gap-2 rounded-lg py-2 pl-2 pr-9 text-left transition-colors',
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
                      archived
                    </Badge>
                  ) : null}
                </button>
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-label={`Actions for ${thread.title}`}
                  onClick={(event) => openMenuFor(thread, () => menu.openBelow(event.currentTarget))}
                  className="absolute right-1 top-1.5 rounded p-1 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
                >
                  <MoreHorizontal aria-hidden className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ContextMenu open={menu.open} position={menu.position} items={items} onClose={menu.close} />
    </div>
  )
}

export function AgentChatWorkspace({
  threads: initialThreads,
  agent,
  avatar,
  callAvatar,
  canStart,
  call,
  startWithCall = false,
  initialThread,
}: {
  threads: ChatThreadSummary[]
  /** The profile owns the person context; every thread here belongs to this agent. */
  agent: ChatAgentOption
  avatar: React.ReactNode
  callAvatar: AgentAvatar
  /** False when no model is assigned, so starting a thread could only fail. */
  canStart: boolean
  call: { serverUrl: string; disabledReason: string | null } | null
  /** A profile Call action lands here and places the call after creating its conversation. */
  startWithCall?: boolean
  /** The thread named in the URL, already loaded, or null. */
  initialThread: ChatThreadDetail | null
}) {
  const router = useRouter()
  const [threads, setThreads] = React.useState(initialThreads)
  const [detail, setDetail] = React.useState<ChatThreadDetail | null>(initialThread)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [deskChoice, setDeskChoice] = React.useState<boolean | null>(null)
  const [callThreadId, setCallThreadId] = React.useState<string | null>(null)
  const [callStarting, setCallStarting] = React.useState(false)
  const [panelGeneration, setPanelGeneration] = React.useState(0)
  const directStreamRef = React.useRef(false)
  const autoCallStartedRef = React.useRef(false)
  // Archived conversations are out of the list by default. The one exception
  // is arriving on a link to one: it would otherwise open in a pane with no row
  // behind it and no way back to itself.
  const [showArchived, setShowArchived] = React.useState(initialThread?.thread.status === 'closed')
  const [searchQuery, setSearchQuery] = React.useState('')
  const searchRequestRef = React.useRef(0)

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
      window.history.replaceState(
        null,
        '',
        `/organization/${encodeURIComponent(agent.id)}?section=chat&thread=${encodeURIComponent(threadId)}`,
      )
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'That conversation could not be opened.')
    } finally {
      setLoading(false)
    }
  }, [agent.id])

  /** The list as this pane is currently asking for it. */
  const fetchThreads = React.useCallback(
    () => listThreadsAction({ includeArchived: showArchived, personId: agent.id, query: searchQuery }),
    [agent.id, searchQuery, showArchived],
  )

  React.useEffect(() => {
    const request = ++searchRequestRef.current
    const timer = window.setTimeout(() => {
      void listThreadsAction({ includeArchived: showArchived, personId: agent.id, query: searchQuery })
        .then((list) => {
          if (searchRequestRef.current === request) setThreads(list)
        })
        .catch((reason) => {
          if (searchRequestRef.current === request) {
            setError(reason instanceof Error ? reason.message : 'Conversations could not be searched.')
          }
        })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [agent.id, searchQuery, showArchived])

  /**
   * What the pane learns after something happens to a thread: the run a turn
   * produced, the name it now carries, and where it sits in the list.
   * Refreshed rather than guessed — the run id is written by the run, and the
   * ordering by the ledger, not by anything here.
   */
  const refreshThread = React.useCallback(
    async (threadId: string) => {
      try {
        const [loaded, list] = await Promise.all([getThreadAction(threadId), fetchThreads()])
        setThreads(list)
        if (loaded === null) return
        // Only the record around the thread is taken: the panel holds the turn
        // that has just streamed, in far more detail than the stored bodies.
        setDetail((current) => (current && current.thread.id === threadId ? loaded : current))
      } catch {
        // The list simply stays as it was; nothing the reader did has been lost.
      }
    },
    [fetchThreads],
  )

  const send = React.useCallback(
    async (prompt: string, signal: AbortSignal): Promise<Response> => {
      const threadId = activeId
      if (threadId === null) throw new Error('No conversation is open.')
      directStreamRef.current = true
      let response: Response
      try {
        response = await fetch(`/api/chat/${encodeURIComponent(threadId)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt, requestId: crypto.randomUUID() }),
          signal,
        })
      } catch (reason) {
        directStreamRef.current = false
        throw reason
      }
      // The panel owns the stream; reading a clone alongside it is how this
      // pane learns the turn is over — without it the run link and the list's
      // ordering would sit stale until the next navigation.
      void response
        .clone()
        .text()
        .then(async () => {
          await refreshThread(threadId)
          // Keep the server-owned snapshot behind this mounted workspace in
          // step with the durable transcript. AgentPanel deliberately keeps
          // its richer streamed parts while mounted; refreshing the RSC tree
          // means a later section switch remounts from the same completed
          // turn instead of the snapshot from before Send was pressed.
          router.refresh()
        })
        .catch(() => undefined)
        .finally(() => {
          directStreamRef.current = false
        })
      return response
    },
    [activeId, refreshThread, router],
  )

  const enqueue = React.useCallback(async (prompt: string): Promise<void> => {
    const threadId = activeId
    if (!threadId) throw new Error('No conversation is open.')
    const result = await enqueueMessageAction(threadId, prompt, crypto.randomUUID())
    if ('error' in result) throw new Error(result.error)
    await refreshThread(threadId)
  }, [activeId, refreshThread])

  const editQueued = React.useCallback(async (message: AgentQueuedMessage) => {
    const next = await promptDialog({
      title: 'Edit queued message',
      label: 'Message',
      initialValue: message.text,
      confirmLabel: 'Save',
    })
    if (next === null || next.trim() === message.text) return
    const result = await editQueuedMessageAction(message.id, next)
    if ('error' in result) {
      setError(result.error)
      return
    }
    await refreshThread(result.dispatch.threadId)
  }, [refreshThread])

  const removeQueued = React.useCallback(async (message: AgentQueuedMessage) => {
    const result = await removeQueuedMessageAction(message.id)
    if ('error' in result) {
      setError(result.error)
      return
    }
    await refreshThread(result.dispatch.threadId)
  }, [refreshThread])

  const retryQueued = React.useCallback(async (message: AgentQueuedMessage) => {
    const result = await retryQueuedMessageAction(message.id)
    if ('error' in result) {
      setError(result.error)
      return
    }
    await refreshThread(result.dispatch.threadId)
  }, [refreshThread])

  // A queued turn may finish in a worker after the request that accepted it
  // has returned. Follow the durable projection while there is pending work;
  // when a new persisted answer lands outside the direct stream, remount the
  // panel from the authoritative transcript.
  React.useEffect(() => {
    const threadId = detail?.thread.id
    if (!threadId || detail.dispatches.length === 0) return
    const timer = window.setInterval(() => {
      void getThreadAction(threadId).then((loaded) => {
        if (!loaded) return
        setDetail((current) => {
          if (!current || current.thread.id !== threadId) return current
          const previousLast = current.messages.at(-1)?.id
          const nextLast = loaded.messages.at(-1)?.id
          if (!directStreamRef.current && previousLast !== nextLast) {
            setPanelGeneration((generation) => generation + 1)
          }
          return loaded
        })
      }).catch(() => undefined)
    }, 1_500)
    return () => window.clearInterval(timer)
  }, [detail?.dispatches.length, detail?.thread.id])

  /**
   * A conversation starts empty and its first turn streams like every other
   * one — the action's documented empty-body path. Anything else would take
   * the opening message down a second road to the same run.
   */
  const startThread = React.useCallback(
    async () => {
      const started = await startThreadAction(agent.id, '')
      const list = await fetchThreads().catch(() => threads)
      setThreads(list)
      await load(started.threadId)
    },
    [agent.id, fetchThreads, load, threads],
  )

  const startCall = React.useCallback(async () => {
    if (!call || call.disabledReason || callStarting) return
    setCallStarting(true)
    setError(null)
    try {
      // A call is a conversation, not an escape hatch from one. Give every
      // call its own thread so its transcript, files, and execution surfaces
      // remain together after the microphone closes.
      const started = await startThreadAction(agent.id, '')
      const list = await fetchThreads().catch(() => threads)
      setThreads(list)
      await load(started.threadId)
      setCallThreadId(started.threadId)
      const url = new URL(window.location.href)
      url.searchParams.delete('call')
      url.searchParams.set('section', 'chat')
      url.searchParams.set('thread', started.threadId)
      window.history.replaceState(null, '', `${url.pathname}?${url.searchParams.toString()}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The call could not be started.')
    } finally {
      setCallStarting(false)
    }
  }, [agent.id, call, callStarting, fetchThreads, load, threads])

  React.useEffect(() => {
    if (!startWithCall || autoCallStartedRef.current) return
    autoCallStartedRef.current = true
    void startCall()
  }, [startCall, startWithCall])

  const finishCall = React.useCallback(() => {
    const threadId = callThreadId
    setCallThreadId(null)
    if (!threadId) return
    void refreshThread(threadId).then(() => router.refresh())
  }, [callThreadId, refreshThread, router])

  const toggleArchived = React.useCallback(async (next: boolean) => {
    setShowArchived(next)
    setError(null)
    try {
      setThreads(await listThreadsAction({ includeArchived: next, personId: agent.id, query: searchQuery }))
    } catch (reason) {
      setShowArchived(!next)
      setError(reason instanceof Error ? reason.message : 'Archived conversations could not be loaded.')
    }
  }, [agent.id, searchQuery])

  /**
   * Naming a conversation by hand. The shared prompt is the app's way of
   * asking for one short string, and it hands back a trimmed value or nothing;
   * the name is checked again on the server, which is where it counts.
   */
  const renameThread = React.useCallback(
    async (thread: ChatThreadSummary) => {
      const next = await promptDialog({
        title: 'Rename conversation',
        label: 'Name',
        initialValue: thread.title,
        confirmLabel: 'Rename',
      })
      if (next === null || next === thread.title) return
      setError(null)
      const result = await renameThreadAction(thread.id, next)
      if ('error' in result) {
        setError(result.error)
        return
      }
      await refreshThread(thread.id)
    },
    [refreshThread],
  )

  const continueConversation = React.useCallback(async (thread: ChatThreadSummary) => {
    setError(null)
    const result = await continueThreadAction(thread.id)
    if ('error' in result) {
      setError(result.error)
      return
    }
    const list = await fetchThreads().catch(() => threads)
    setThreads(list)
    await load(result.threadId)
  }, [fetchThreads, load, threads])

  const exportConversation = React.useCallback((thread: ChatThreadSummary, format: 'md' | 'json') => {
    const url = `/api/chat/${encodeURIComponent(thread.id)}/export?format=${format}`
    window.location.assign(url)
  }, [])

  /**
   * Archiving, and bringing one back. Never a delete: the conversation's
   * messages carry the ids of the runs that did the work, so putting it away is
   * the most that may happen to it.
   */
  const setThreadStatus = React.useCallback(
    async (thread: ChatThreadSummary, status: ChatThreadStatus) => {
      setError(null)
      const result = await setThreadStatusAction(thread.id, status)
      if ('error' in result) {
        setError(result.error)
        return
      }
      await refreshThread(thread.id)
    },
    [refreshThread],
  )

  const conversation = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface max-lg:min-h-[28rem]">
      {detail === null ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {loading ? (
            <div className="flex min-h-0 flex-1 items-center justify-center p-6">
              <span className="flex items-center gap-2 text-sm text-fg-muted">
                <Loader2 aria-hidden className="size-4 animate-spin" />
                Opening the conversation…
              </span>
            </div>
          ) : threads.length === 0 && canStart ? (
            <ConversationWelcome agent={agent} avatar={callAvatar} />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center p-6">
              <EmptyState
                title={threads.length === 0 ? 'Conversation unavailable' : 'Pick a conversation'}
                description={
                  !canStart
                    ? `${agent.name} needs an assigned model before they can hold a conversation.`
                    : 'Choose a conversation on the left, or start a new one.'
                }
                action={
                  !canStart ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/organization/${agent.id}?section=profile`}>Open profile</Link>
                    </Button>
                  ) : (
                    <Button type="button" size="sm" onClick={() => void startThread()}>
                      <MessageSquarePlus aria-hidden className="size-4" />
                      New conversation
                    </Button>
                  )
                }
              />
            </div>
          )}
        </div>
      ) : callThreadId === detail.thread.id && call ? (
        <>
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface px-4">
            <Phone aria-hidden className="size-4 text-primary" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">Call with {detail.thread.personName}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              aria-pressed={deskOpen}
              onClick={() => setDeskChoice(!deskOpen)}
            >
              {deskOpen ? <PanelRightClose aria-hidden className="size-4" /> : <Monitor aria-hidden className="size-4" />}
              {deskOpen ? 'Hide work' : 'Show work'}
            </Button>
          </header>
          <div className="min-h-0 flex-1">
            <ConversationCall
              serverUrl={call.serverUrl}
              agent={agent}
              avatar={callAvatar}
              threadId={detail.thread.id}
              onEnded={finishCall}
            />
          </div>
        </>
      ) : (
        <>
          <ContinuationNotice originThreadId={detail.thread.originThreadId} onOpen={(id) => void load(id)} />
          <ThreadNoticeBar messages={detail.messages} />
          <AgentPanel
            // Keyed by the thread: the panel seeds its transcript once, so a
            // different conversation has to be a different panel.
            key={`${detail.thread.id}:${panelGeneration}`}
            // An archived conversation is closed to new turns on the server, so
            // the composer is closed here too rather than offering a Send that
            // is only going to be refused.
            enabled={detail.thread.status === 'open'}
            initialMessages={detail.messages.map(toAgentMessage)}
            send={send}
            dispatchState={
              detail.dispatches.some((dispatch) => dispatch.status === 'running')
                ? 'running'
                : detail.dispatches.some((dispatch) => dispatch.status === 'failed')
                  ? 'recovering'
                  : 'idle'
            }
            queuedMessages={detail.dispatches.map((dispatch, index) => ({
              id: dispatch.id,
              text: dispatch.body,
              position: index + 1,
              status: dispatch.status === 'running' ? 'dispatching' : dispatch.status === 'failed' ? 'failed' : 'queued',
              ...(dispatch.status === 'failed' && dispatch.lastError ? { statusLabel: dispatch.lastError } : {}),
              editable: dispatch.status === 'queued' || dispatch.status === 'failed',
              removable: dispatch.status === 'queued' || dispatch.status === 'failed',
              retryable: dispatch.status === 'failed',
            }))}
            enqueue={enqueue}
            onEditQueuedMessage={(message) => void editQueued(message)}
            onRemoveQueuedMessage={(message) => void removeQueued(message)}
            onRetryQueuedMessage={(message) => void retryQueued(message)}
            emptyContent={<ConversationWelcome agent={agent} avatar={callAvatar} />}
            headerActions={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                aria-pressed={deskOpen}
                onClick={() => setDeskChoice(!deskOpen)}
              >
                {deskOpen ? (
                  <PanelRightClose aria-hidden className="size-4" />
                ) : (
                  <Monitor aria-hidden className="size-4" />
                )}
                {deskOpen ? 'Hide work' : 'Show work'}
              </Button>
            }
            labels={{
              title: `${detail.thread.personName} · ${detail.thread.title}`,
              disabledTitle: 'This conversation is archived',
              disabledDescription:
                'Everything said in it is still here, and so are its run records. Unarchive it from the list to carry on.',
              placeholder: `Message ${detail.thread.personName}…`,
              failed:
                'That turn did not finish. Nothing has been lost — ask again, or open the run record to see how far it got.',
              queueFailed: 'That queued turn needs attention before the conversation can continue.',
            }}
          />
        </>
      )}
    </div>
  )

  // This pane belongs to the agent, not to one run. Desktop is the primary
  // visual stage, while History follows every run in the selected conversation
  // and remains separate from the transcript.
  const deskVisible = deskOpen

  return (
    <div className="flex min-h-[36rem] flex-col lg:h-full lg:min-h-0">
      {error !== null ? (
        <p role="alert" className="shrink-0 pb-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {/* One card, three panes — divided, not spaced. Three cards with air
          between them read as three separate screens; this is one screen
          with the list, the conversation and the machine side by side in it,
          so the seams are hairlines and the panes carry the padding.
          `divide-*` puts them between the panes only, and follows the
          stacking: a row rule below `lg`, a column rule above it. The middle
          column is the only elastic one, so a wider window goes to the
          conversation and the desk keeps its shape. */}
      <Card
        className={cn(
          'grid divide-y divide-border overflow-hidden lg:min-h-0 lg:flex-1 lg:grid-rows-[minmax(0,1fr)] lg:divide-x lg:divide-y-0',
          deskVisible
            ? 'lg:grid-cols-[14rem_minmax(0,1fr)_minmax(0,22rem)] xl:grid-cols-[15rem_minmax(0,1fr)_minmax(0,28rem)]'
            : 'lg:grid-cols-[15rem_minmax(0,1fr)]',
        )}
      >
        <ThreadList
          threads={threads}
          activeId={activeId}
          avatars={{ [agent.id]: avatar }}
          onSelect={(id) => void load(id)}
          onNew={() => void startThread()}
          onNewCall={() => void startCall()}
          canStart={canStart}
          canCall={Boolean(call && !call.disabledReason && !callStarting)}
          showArchived={showArchived}
          onShowArchived={(next) => void toggleArchived(next)}
          onRename={(thread) => void renameThread(thread)}
          onSetStatus={(thread, status) => void setThreadStatus(thread, status)}
          onContinue={(thread) => void continueConversation(thread)}
          onExport={exportConversation}
          query={searchQuery}
          onQueryChange={setSearchQuery}
        />
        {conversation}
        {/* Unmounted rather than hidden when it is folded away: a pane that
            is not on screen must not be holding a frame stream open. */}
        {deskVisible ? (
          <div className="min-h-0 max-lg:h-[34rem]">
            <ChatWorkSurface
              key={agent.id}
              threadId={detail?.thread.id ?? null}
              personId={agent.id}
              personName={agent.name}
            />
          </div>
        ) : null}
      </Card>
    </div>
  )
}
