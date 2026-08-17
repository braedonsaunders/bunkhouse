import { eq, and } from 'drizzle-orm'
import { schema as identity } from '@braedonsaunders/appkit-db'
import { db } from '../src/db/client'
import { duties, people } from '../src/db/schema'
import { executeAgentRun } from '../src/lib/agent-runs'

const app = db()
const [tenant] = await app.withSuperAdmin((s) =>
  s.select({ id: identity.tenants.id }).from(identity.tenants).where(eq(identity.tenants.status, 'active')).limit(1),
)
const tenantId = tenant!.id
const [person] = await app.withTenantContext(tenantId, () =>
  app.db.select().from(people).where(eq(people.email, process.argv[2]!)),
)
const [duty] = await app.withTenantContext(tenantId, () =>
  app.db.select().from(duties).where(and(eq(duties.personId, person!.id), eq(duties.slug, process.argv[3]!))),
)
if (!duty) throw new Error('duty not found')
const started = Date.now()
const { runId, outcome } = await executeAgentRun({
  tenantId,
  personId: person!.id,
  trigger: { type: 'duty', dutyId: duty.id },
  input: { type: 'duty', dutyTitle: duty.title, instruction: duty.instruction },
})
console.log(`RUN ${runId} status=${outcome.status} seconds=${Math.round((Date.now() - started) / 1000)}`)
await app.pool.end()
await app.superPool.end()
