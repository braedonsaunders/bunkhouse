// Wire an agent into the mail lab through the REAL connect path.
// Usage: pnpm tsx --env-file=.env.local scripts/dev-mail-lab.mts [address ...]
// With no arguments every agent in the directory is connected, so a fresh
// dev database gets a working inbox for the whole roster in one pass.
import { eq } from 'drizzle-orm'
import { schema as identity } from '@appkit/db'
import { db } from '../src/db/client'
import { mailboxAccounts, people } from '../src/db/schema'
import { connectMailbox } from '../src/lib/mailbox'

// greenmail runs with -Dgreenmail.auth.disabled, so the mailbox is created on
// first use and the password is a placeholder the lab never checks.
const LAB_PASSWORD = 'dev'

// Where the lab servers answer FROM THE APP'S POINT OF VIEW, which is not
// always where they answer from here. Compose publishes both to the host, so
// localhost is right when the app runs on this machine; in the deployed stack
// they are services on the same network and the app must be told their names.
// Pointing a deployment at localhost writes mailboxes that can never connect —
// the app's localhost is the app — and the failure surfaces days later as mail
// that silently never sent. Defaults suit the local compose file; override for
// anything else.
const IMAP_HOST = process.env.BUNKHOUSE_LAB_IMAP_HOST ?? 'localhost'
const SMTP_HOST = process.env.BUNKHOUSE_LAB_SMTP_HOST ?? 'localhost'
const IMAP_PORT = Number(process.env.BUNKHOUSE_LAB_IMAP_PORT ?? 3143)
const SMTP_PORT = Number(process.env.BUNKHOUSE_LAB_SMTP_PORT ?? 1025)

const app = db()
// Resolved here rather than through lib/tenant: that module reaches for the
// request's headers, which a plain script has none of.
const [tenant] = await app.withSuperAdmin((superDb) =>
  superDb
    .select({ id: identity.tenants.id })
    .from(identity.tenants)
    .where(eq(identity.tenants.status, 'active'))
    .limit(1),
)
if (!tenant) throw new Error('No active tenant found.')
const tenantId = tenant.id
const requested = process.argv.slice(2)

const roster = await app.withTenantContext(tenantId, () =>
  app.db.select().from(people).where(eq(people.kind, 'agent')),
)
const targets = requested.length
  ? requested.map((address) => {
      const person = roster.find((p) => p.email.toLowerCase() === address.toLowerCase())
      if (!person) throw new Error(`No agent in the directory has the address ${address}`)
      return person
    })
  : roster

if (targets.length === 0) throw new Error('No agents to connect.')

const connected = await app.withTenantContext(tenantId, () =>
  app.db.select({ personId: mailboxAccounts.personId }).from(mailboxAccounts),
)
const alreadyConnected = new Set(connected.map((row) => row.personId))

for (const person of targets) {
  // Re-running the lab setup must not blow up on the agents it already wired.
  if (alreadyConnected.has(person.id)) {
    console.log(`${person.name} already connected: ${person.email} — skipped`)
    continue
  }
  await connectMailbox({
    tenantId,
    personId: person.id,
    address: person.email,
    username: person.email,
    password: LAB_PASSWORD,
    imapHost: IMAP_HOST,
    imapPort: IMAP_PORT,
    imapSecure: false,
    smtpHost: SMTP_HOST,
    smtpPort: SMTP_PORT,
    smtpSecure: false,
  })
  console.log(
    `${person.name} connected: ${person.email} — IMAP ${IMAP_HOST}:${IMAP_PORT}, SMTP ${SMTP_HOST}:${SMTP_PORT}`,
  )
}

await app.pool.end()
await app.superPool.end()
