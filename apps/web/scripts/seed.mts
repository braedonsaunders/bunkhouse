import { createDb, createTenant, createUser, addMembership, schema as identity } from '@appkit/db'
import { eq } from 'drizzle-orm'
import * as bunkhouse from '../src/db/schema/index.ts'

// Bootstrap the sole tenant plus the human side of the mixed directory.
// Idempotent: re-running against an already-seeded database changes nothing.
// The owner user is created without a credential — sign-in arrives with the
// auth slice, which hashes and attaches passwords itself.

const url = process.env.BUNKHOUSE_DB_URL
const superUrl = process.env.BUNKHOUSE_SUPER_URL
if (!url || !superUrl) throw new Error('BUNKHOUSE_DB_URL and BUNKHOUSE_SUPER_URL must be set')

const schema = { ...identity, ...bunkhouse }
const app = createDb({ url, superUrl, schema })

const COMPANY = 'Bunkhouse Demo Co'
const SLUG = 'bunkhouse-demo'
const OWNER_EMAIL = 'owner@bunkhouse.local'

const tenantId = await app.withSuperAdmin(async (superDb) => {
  const existing = await superDb
    .select({ id: identity.tenants.id })
    .from(identity.tenants)
    .where(eq(identity.tenants.slug, SLUG))
  if (existing.length > 0) {
    console.log(`tenant exists: ${COMPANY} (${existing[0]!.id})`)
    return existing[0]!.id
  }
  const tenant = await createTenant(superDb, { name: COMPANY, slug: SLUG })
  const user = await createUser(superDb, { email: OWNER_EMAIL, name: 'Demo Owner' })
  await addMembership(superDb, { tenantId: tenant.id, userId: user.id, displayName: 'Demo Owner' })
  console.log(`tenant created: ${COMPANY} (${tenant.id}); owner ${OWNER_EMAIL} (no credential until auth ships)`)
  return tenant.id
})

const humans = [
  {
    name: 'Demo Owner',
    title: 'Owner',
    email: OWNER_EMAIL,
    responsibilities: 'Final say on money, pricing, legal, and anything a hand escalates.',
  },
  {
    name: 'Sam Ellis',
    title: 'Operations Manager',
    email: 'sam@bunkhouse.local',
    responsibilities: 'Scheduling, vendors, day-to-day operations questions.',
  },
]

await app.withTenant(tenantId, async () => {
  for (const human of humans) {
    await app.db
      .insert(bunkhouse.people)
      .values({ tenantId, kind: 'human', status: 'active', ...human })
      .onConflictDoNothing()
  }
})
console.log(`seeded ${humans.length} humans into the directory`)
await app.pool.end()
await app.superPool.end()
