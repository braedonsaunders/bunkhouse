import Link from 'next/link'
import { desc, eq } from 'drizzle-orm'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
} from '@appkit/ui'
import { mailboxAccounts, mailThreads } from '../../db/schema'
import { db } from '../../db/client'
import { connectMailboxAction, syncMailboxAction } from './actions'

/** The hand's mail surface: connect form, account status, and live threads. */
export async function MailboxSection({ tenantId, personId }: { tenantId: string; personId: string }) {
  const app = db()
  const data = await app.withTenantContext(tenantId, async () => {
    const [account] = await app.db
      .select()
      .from(mailboxAccounts)
      .where(eq(mailboxAccounts.personId, personId))
    if (!account) return { account: null, threads: [] as (typeof mailThreads.$inferSelect)[] }
    const threads = await app.db
      .select()
      .from(mailThreads)
      .where(eq(mailThreads.mailboxId, account.id))
      .orderBy(desc(mailThreads.lastMessageAt))
      .limit(15)
    return { account, threads }
  })

  if (!data.account) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Mailbox</CardTitle>
          <CardDescription>
            Connect a real address on your domain — colleagues and customers just email them. Credentials are
            verified against both endpoints, then sealed at rest.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={connectMailboxAction} className="grid gap-4 md:grid-cols-2">
            <input type="hidden" name="personId" value={personId} />
            <div className="space-y-2">
              <Label htmlFor="address">Email address</Label>
              <Input id="address" name="address" type="email" placeholder="dana@yourcompany.com" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="username">Username (defaults to the address)</Label>
              <Input id="username" name="username" placeholder="dana@yourcompany.com" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password / app password</Label>
              <Input id="password" name="password" type="password" required />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-2">
                <Label htmlFor="imapHost">IMAP host</Label>
                <Input id="imapHost" name="imapHost" placeholder="imap.fastmail.com" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="imapPort">IMAP port</Label>
                <Input id="imapPort" name="imapPort" type="number" defaultValue={993} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-2">
                <Label htmlFor="smtpHost">SMTP host</Label>
                <Input id="smtpHost" name="smtpHost" placeholder="smtp.fastmail.com" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="smtpPort">SMTP port</Label>
                <Input id="smtpPort" name="smtpPort" type="number" defaultValue={465} />
              </div>
            </div>
            <div className="md:col-span-2">
              <Button type="submit">Verify & connect</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    )
  }

  const { account, threads } = data
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span>Mailbox — {account.address}</span>
          <span className="flex items-center gap-2">
            <Badge variant={account.status === 'active' ? 'default' : 'destructive'}>{account.status}</Badge>
            <form action={syncMailboxAction}>
              <input type="hidden" name="personId" value={personId} />
              <Button type="submit" variant="outline" size="sm">
                Sync now
              </Button>
            </form>
          </span>
        </CardTitle>
        <CardDescription>
          {account.lastSyncAt
            ? `Last synced ${account.lastSyncAt.toISOString().slice(0, 16).replace('T', ' ')}`
            : 'Never synced yet.'}
          {account.lastError ? ` · last error: ${account.lastError}` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {threads.length === 0 ? (
          <EmptyState title="No threads yet" description="Inbound mail lands here after the next sync." />
        ) : (
          <div className="space-y-2">
            {threads.map((thread) => (
              <Link
                key={thread.id}
                href={`/mail/${thread.id}`}
                className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm transition-colors hover:border-primary/50"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{thread.subject}</p>
                  <p className="truncate text-fg-muted">
                    {thread.participants.map((p) => p.name || p.address).join(', ')}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-fg-muted">
                  {thread.lastMessageAt.toISOString().slice(0, 16).replace('T', ' ')}
                </span>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
