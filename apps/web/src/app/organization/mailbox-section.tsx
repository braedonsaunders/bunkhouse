import { eq } from 'drizzle-orm'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@appkit/ui'
import { mailboxAccounts, people } from '../../db/schema'
import { db } from '../../db/client'
import { listMailOauthApps } from '../../lib/mail-oauth'
import { loadMailConversationAction, loadMailFolderAction } from '../mail/actions'
import { AgentMailInbox } from '../../components/agent-mail-inbox'
import { connectMailboxAction, disconnectMailboxAction, syncMailboxAction } from './actions'

/** A failed sign-in round-trip, shown where the operator started it. */
function MailboxError({ message }: { message: string }) {
  return (
    <div className="mb-4 rounded-md border border-danger/40 bg-danger-subtle px-3 py-2 text-sm">
      <p className="text-xs text-fg-muted">Mailbox not connected</p>
      <p>{message}</p>
    </div>
  )
}

/** The agent's mail surface: their whole inbox, on their own record. */
export async function MailboxSection({
  tenantId,
  personId,
  selectedThreadId,
  error,
}: {
  tenantId: string
  personId: string
  /** Deep-linked conversation (old /mail links, run references). */
  selectedThreadId?: string | undefined
  /** Surfaced when a Google/Microsoft sign-in came back without connecting. */
  error?: string | undefined
}) {
  const app = db()
  const data = await app.withTenantContext(tenantId, async () => {
    // This person's mailbox and nobody else's — the drawer is open on them, so
    // the inbox it shows is theirs and does not offer to become someone
    // else's. Their colleague's mail is on their colleague's record.
    const [account] = await app.db
      .select({
        id: mailboxAccounts.id,
        address: mailboxAccounts.address,
        provider: mailboxAccounts.provider,
        status: mailboxAccounts.status,
        lastSyncAt: mailboxAccounts.lastSyncAt,
        lastError: mailboxAccounts.lastError,
        ownerName: people.name,
      })
      .from(mailboxAccounts)
      .innerJoin(people, eq(people.id, mailboxAccounts.personId))
      .where(eq(mailboxAccounts.personId, personId))
    return { account: account ?? null }
  })
  const signInApps = await listMailOauthApps(tenantId)

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
          {error ? <MailboxError message={error} /> : null}
          {signInApps.length > 0 ? (
            <div className="mb-6 space-y-2">
              <div className="flex flex-wrap gap-2">
                {signInApps.map((signIn) => (
                  <Button key={signIn.provider} asChild>
                    <a href={`/api/mail-oauth/start?personId=${personId}&provider=${signIn.provider}`}>
                      Connect {signIn.label}
                    </a>
                  </Button>
                ))}
              </div>
              <p className="text-sm text-fg-muted">
                Sign in as the agent&rsquo;s own account — nothing is stored but a sealed sign-in token you can revoke
                at any time. Use the form below only for mail you host yourself.
              </p>
            </div>
          ) : null}
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

  const { account } = data
  // A mailbox signed in through Google/Microsoft can have its consent revoked
  // on the provider's side; re-signing in is the fix, so offer it in place.
  const signIn = signInApps.find(
    (entry) =>
      (entry.provider === 'google' && account.provider === 'gmail') ||
      (entry.provider === 'microsoft' && account.provider === 'microsoft'),
  )

  // The deep-linked thread opens in 'all' so it is present whatever folder
  // semantics it matches; otherwise the inbox opens on Inbox.
  const initialFolder = selectedThreadId ? ('all' as const) : ('inbox' as const)
  const initial = await loadMailFolderAction({ mailboxId: account.id, folder: initialFolder })
  const initialThreadId = selectedThreadId && initial.threads.some((t) => t.id === selectedThreadId) ? selectedThreadId : null
  const initialConversation = initialThreadId
    ? await loadMailConversationAction({ threadId: initialThreadId })
    : null
  const firstName = account.address.split('@')[0]

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-bg-subtle px-3 py-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium text-fg">
            <span className="truncate">{account.address}</span>
            <Badge variant={account.status === 'active' ? 'default' : 'destructive'}>{account.status}</Badge>
          </p>
          <p className="truncate text-xs text-fg-muted">
            {account.lastSyncAt
              ? `Last synced ${account.lastSyncAt.toISOString().slice(0, 16).replace('T', ' ')}`
              : 'Never synced yet.'}
            {account.lastError ? ` · last error: ${account.lastError}` : ''}
          </p>
        </div>
        <span className="flex items-center gap-2">
          {signIn ? (
            <Button asChild variant="outline" size="sm">
              <a href={`/api/mail-oauth/start?personId=${personId}&provider=${signIn.provider}`}>Sign in again</a>
            </Button>
          ) : null}
          <form action={syncMailboxAction}>
            <input type="hidden" name="personId" value={personId} />
            <Button type="submit" variant="outline" size="sm">
              Sync now
            </Button>
          </form>
          <form action={disconnectMailboxAction}>
            <input type="hidden" name="personId" value={personId} />
            <Button type="submit" variant="outline" size="sm">
              Disconnect
            </Button>
          </form>
        </span>
      </div>
      {error ? <MailboxError message={error} /> : null}
      <div className="min-h-0 flex-1">
        <AgentMailInbox
          mailbox={{ id: account.id, ownerName: account.ownerName, address: account.address }}
          replyLabel={`Reply as ${account.ownerName || firstName}`}
          initialFolder={initialFolder}
          initialCounts={initial.counts}
          initialThreads={initial.threads}
          initialThreadId={initialThreadId}
          initialConversation={initialConversation}
        />
      </div>
    </div>
  )
}
