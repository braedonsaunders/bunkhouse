import { notFound } from 'next/navigation'
import { asc, eq } from 'drizzle-orm'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DetailHeader,
  PageContainer,
  Textarea,
  cn,
} from '@appkit/ui'
import { mailboxAccounts, mailMessages, mailThreads, people } from '../../../db/schema'
import { db } from '../../../db/client'
import { resolveTenantId } from '../../../lib/tenant'
import { replyAction } from './actions'

export const dynamic = 'force-dynamic'

export default async function ThreadPage({ params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params
  const tenantId = await resolveTenantId()
  const app = db()

  const data = await app.withTenantContext(tenantId, async () => {
    const [thread] = await app.db.select().from(mailThreads).where(eq(mailThreads.id, threadId))
    if (!thread) return null
    const [account] = await app.db
      .select()
      .from(mailboxAccounts)
      .where(eq(mailboxAccounts.id, thread.mailboxId))
    const [owner] = account
      ? await app.db
          .select({ id: people.id, name: people.name, title: people.title })
          .from(people)
          .where(eq(people.id, account.personId))
      : []
    const messages = await app.db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.threadId, thread.id))
      .orderBy(asc(mailMessages.sentAt))
    return { thread, owner: owner ?? null, messages }
  })

  if (!data) notFound()
  const { thread, owner, messages } = data

  return (
    <PageContainer className="space-y-6">
      <DetailHeader
        back={owner ? { href: `/people/${owner.id}`, label: owner.name } : { href: '/people', label: 'Directory' }}
        title={thread.subject}
        subtitle={owner ? `${owner.name}'s mailbox · ${thread.participants.length} participants` : undefined}
        badge={<Badge variant={thread.open ? 'default' : 'outline'}>{thread.open ? 'open' : 'closed'}</Badge>}
      />

      <div className="space-y-3">
        {messages.map((message) => (
          <Card
            key={message.id}
            className={cn(message.direction === 'outbound' && 'border-primary/40 bg-primary/5')}
          >
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
                <span>
                  {message.from.name || message.from.address}
                  <span className="ml-2 font-normal text-fg-muted">
                    → {message.to.map((t) => t.name || t.address).join(', ')}
                  </span>
                </span>
                <span className="flex items-center gap-2 text-xs font-normal text-fg-muted">
                  {message.direction === 'outbound' ? <Badge variant="secondary">sent</Badge> : null}
                  {message.sentAt.toISOString().slice(0, 16).replace('T', ' ')}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="whitespace-pre-wrap text-sm">{message.bodyText}</CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Reply as {owner?.name ?? 'the hand'}</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={replyAction} className="space-y-3">
            <input type="hidden" name="threadId" value={thread.id} />
            <Textarea name="text" rows={5} placeholder="Write the reply…" required />
            <Button type="submit">Send reply</Button>
          </form>
        </CardContent>
      </Card>
    </PageContainer>
  )
}
