// One-off: wire Dana into the local mail lab through the REAL connect path.
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client'
import { people } from '../src/db/schema'
import { connectMailbox } from '../src/lib/mailbox'
import { resolveTenantId } from '../src/lib/tenant'

const tenantId = await resolveTenantId()
const app = db()
const [dana] = await app.withTenantContext(tenantId, () =>
  app.db.select().from(people).where(eq(people.email, 'dana@bunkhouse.local')),
)
if (!dana) throw new Error('Dana not found')
await connectMailbox({
  tenantId,
  personId: dana.id,
  address: 'dana@bunkhouse.local',
  username: 'dana@bunkhouse.local',
  password: 'dev',
  imapHost: 'localhost',
  imapPort: 3143,
  imapSecure: false,
  smtpHost: 'localhost',
  smtpPort: 1025,
  smtpSecure: false,
})
console.log('Dana connected: IMAP greenmail:3143, SMTP mailpit:1025')
await app.pool.end()
await app.superPool.end()
