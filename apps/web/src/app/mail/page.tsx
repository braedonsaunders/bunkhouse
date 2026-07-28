import Link from 'next/link'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  PageContainer,
  PageHeader,
  Textarea,
  cn,
} from '@appkit/ui'
import { formatAttachmentSize } from '@appkit/storage'
import { mailboxAccounts, mailMessages, mailThreads, people } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId } from '../../lib/tenant'
import { MailCompose } from '../../components/mail-compose'
import { replyAction } from './actions'

export const dynamic = 'force-dynamic'

type Folder = 'inbox' | 'sent' | 'all'
const FOLDERS: { key: Folder; label: string }[] = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'sent', label: 'Sent' },
  { key: 'all', label: 'All mail' },
]

function stamp(at: Date): string {
  return at.toISOString().slice(0, 16).replace('T', ' ')
}

/**
 * Mail — every agent's actual mailbox, the way an operator expects to read
 * one: mailboxes and folders on the rail, the thread list beside them, the
 * conversation in the reading pane. Selection is all in the URL, so any view
 * here is linkable from a run, an approval, or a colleague's message.
 */
export default async function MailPage({
  searchParams,
}: {
  searchParams: Promise<{ mailbox?: string; folder?: string; thread?: string }>
}) {
  const params = await searchParams
  const tenantId = await resolveTenantId()
  const app = db()

  const data = await app.withTenantContext(tenantId, async () => {
    const accounts = await app.db
      .select({
        id: mailboxAccounts.id,
        address: mailboxAccounts.address,
        status: mailboxAccounts.status,
        personId: mailboxAccounts.personId,
        personName: people.name,
        personTitle: people.title,
      })
      .from(mailboxAccounts)
      .innerJoin(people, eq(people.id, mailboxAccounts.personId))
      .orderBy(asc(people.name))
    const account = accounts.find((a) => a.id === params.mailbox) ?? accounts[0] ?? null
    if (!account) return { accounts, account: null, folder: 'inbox' as Folder, threads: [], selected: null }

    const folder: Folder = params.folder === 'sent' || params.folder === 'all' ? params.folder : 'inbox'
    const directionFilter =
      folder === 'inbox'
        ? sql`exists (select 1 from mail_messages m where m.thread_id = ${mailThreads.id} and m.direction = 'inbound')`
        : folder === 'sent'
          ? sql`exists (select 1 from mail_messages m where m.thread_id = ${mailThreads.id} and m.direction = 'outbound')`
          : sql`true`
    const threads = await app.db
      .select()
      .from(mailThreads)
      .where(and(eq(mailThreads.mailboxId, account.id), directionFilter))
      .orderBy(desc(mailThreads.lastMessageAt))
      .limit(50)

    const selectedThread = threads.find((t) => t.id === params.thread) ?? null
    const messages = selectedThread
      ? await app.db
          .select()
          .from(mailMessages)
          .where(eq(mailMessages.threadId, selectedThread.id))
          .orderBy(asc(mailMessages.sentAt))
      : []
    return { accounts, account, folder, threads, selected: selectedThread ? { thread: selectedThread, messages } : null }
  })

  if (!data.account) {
    return (
      <PageContainer className="space-y-6">
        <PageHeader title="Mail" description="Every agent's mailbox, threads, and sent mail." />
        <EmptyState
          title="No mailboxes connected"
          description="Connect an agent's mailbox from the Mailbox tab on their profile — inbound and sent mail lands here."
          action={
            <Button asChild variant="outline">
              <Link href="/organization/agents">Open Agents</Link>
            </Button>
          }
        />
      </PageContainer>
    )
  }

  const { accounts, account, folder, threads, selected } = data
  const withParams = (next: { mailbox?: string; folder?: Folder; thread?: string | null }): string => {
    const query = new URLSearchParams()
    query.set('mailbox', next.mailbox ?? account.id)
    query.set('folder', next.folder ?? folder)
    if (next.thread) query.set('thread', next.thread)
    return `/mail?${query.toString()}`
  }
  const counterpartiesOf = (thread: (typeof threads)[number]): string =>
    thread.participants
      .filter((p) => p.address.toLowerCase() !== account.address.toLowerCase())
      .map((p) => p.name || p.address)
      .join(', ') || account.address

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Mail"
        description="Agents' real mailboxes — the audit log itself. Replies and new messages you write here go out from the agent's own address."
        actions={<MailCompose accountId={account.id} address={account.address} />}
      />

      <div className="grid items-start gap-4 lg:grid-cols-[15rem_minmax(0,22rem)_minmax(0,1fr)]">
        {/* Rail: mailboxes, then folders for the open one. */}
        <nav aria-label="Mailboxes" className="space-y-1">
          {accounts.map((entry) => {
            const active = entry.id === account.id
            return (
              <div key={entry.id}>
                <Link
                  href={withParams({ mailbox: entry.id, folder: 'inbox', thread: null })}
                  className={cn(
                    'block rounded-md border px-3 py-2 text-sm transition-colors',
                    active ? 'border-primary/50 bg-primary-subtle' : 'border-transparent hover:bg-surface-hover',
                  )}
                >
                  <p className="truncate font-medium text-fg">{entry.personName}</p>
                  <p className="truncate text-xs text-fg-muted">{entry.address}</p>
                </Link>
                {active ? (
                  <div className="mb-2 mt-1 space-y-0.5 pl-3">
                    {FOLDERS.map((f) => (
                      <Link
                        key={f.key}
                        href={withParams({ folder: f.key, thread: null })}
                        className={cn(
                          'block rounded-md px-3 py-1.5 text-sm transition-colors',
                          f.key === folder ? 'bg-primary-subtle font-medium text-fg' : 'text-fg-muted hover:bg-surface-hover',
                        )}
                      >
                        {f.label}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
        </nav>

        {/* Thread list for the open folder. */}
        <div className="space-y-1">
          {threads.length === 0 ? (
            <EmptyState
              title={folder === 'sent' ? 'Nothing sent yet' : 'No mail here yet'}
              description={
                folder === 'sent'
                  ? 'Messages the agent sends show up in this folder.'
                  : 'Inbound mail lands here after the next sync.'
              }
            />
          ) : (
            threads.map((thread) => (
              <Link
                key={thread.id}
                href={withParams({ thread: thread.id })}
                className={cn(
                  'block rounded-md border px-3 py-2 text-sm transition-colors',
                  selected?.thread.id === thread.id
                    ? 'border-primary/50 bg-primary-subtle'
                    : 'border-border hover:border-primary/40',
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate font-medium text-fg">{counterpartiesOf(thread)}</p>
                  <span className="shrink-0 text-xs tabular-nums text-fg-muted">{stamp(thread.lastMessageAt)}</span>
                </div>
                <p className="truncate text-fg">{thread.subject}</p>
                {!thread.open ? <Badge variant="outline">closed</Badge> : null}
              </Link>
            ))
          )}
        </div>

        {/* Reading pane. */}
        {selected ? (
          <div className="space-y-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between gap-2 text-base">
                  <span className="min-w-0 truncate">{selected.thread.subject}</span>
                  <Badge variant={selected.thread.open ? 'default' : 'outline'}>
                    {selected.thread.open ? 'open' : 'closed'}
                  </Badge>
                </CardTitle>
              </CardHeader>
            </Card>
            {selected.messages.map((message) => (
              <Card key={message.id} className={cn(message.direction === 'outbound' && 'border-primary/40 bg-primary/5')}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
                    <span className="min-w-0 truncate">
                      {message.from.name || message.from.address}
                      <span className="ml-2 font-normal text-fg-muted">
                        → {message.to.map((t) => t.name || t.address).join(', ')}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-xs font-normal text-fg-muted">
                      {message.direction === 'outbound' ? <Badge variant="secondary">sent</Badge> : null}
                      {stamp(message.sentAt)}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="whitespace-pre-wrap text-sm">{message.bodyText}</div>
                  {message.attachments.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {message.attachments.map((attachment) => (
                        <a
                          key={attachment.fileId}
                          href={`/api/files/${attachment.fileId}`}
                          download={attachment.filename}
                          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg transition-colors hover:bg-surface-hover"
                        >
                          <span className="font-medium">{attachment.filename}</span>
                          <span className="text-fg-muted">{formatAttachmentSize(attachment.size)}</span>
                        </a>
                      ))}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ))}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Reply as {account.personName}</CardTitle>
              </CardHeader>
              <CardContent>
                <form action={replyAction} className="space-y-3">
                  <input type="hidden" name="threadId" value={selected.thread.id} />
                  <Textarea name="text" rows={4} placeholder="Write the reply…" required />
                  <Button type="submit">Send reply</Button>
                </form>
              </CardContent>
            </Card>
          </div>
        ) : (
          <EmptyState
            title="Pick a conversation"
            description={`Reading ${account.personName}'s ${folder === 'sent' ? 'sent mail' : folder === 'all' ? 'mail' : 'inbox'} — select a thread to open it.`}
          />
        )}
      </div>
    </PageContainer>
  )
}
