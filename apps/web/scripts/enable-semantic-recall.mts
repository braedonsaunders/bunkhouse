/**
 * Finish turning semantic recall on, once a superuser has installed pgvector.
 *
 * `CREATE EXTENSION vector` needs a database superuser, which the application
 * roles are not, so migration 0052 adds the column only where the extension is
 * already present. This is the other half: run it after
 *
 *     psql "$SUPERUSER_URL" -c 'CREATE EXTENSION vector;'
 *
 * and it adds the column, builds the index, and embeds every live note.
 * Idempotent — safe to run again, and safe to run before the extension exists,
 * in which case it says what is missing and changes nothing.
 *
 *   pnpm --filter web exec tsx --env-file=.env.local scripts/enable-semantic-recall.mts
 */
import { and, eq, isNull, sql } from 'drizzle-orm'
import { schema as identity } from '@appkit/db'
import { memories } from '../src/db/schema'
import { db } from '../src/db/client'
import { embedTexts, embeddableText, toVectorLiteral } from '../src/lib/embeddings'

const app = db()

const rowsOf = (result: unknown): unknown[] => {
  const maybe = (result as { rows?: unknown[] }).rows
  return maybe ?? (Array.isArray(result) ? result : [])
}

const installed = rowsOf(await app.db.execute(sql`select 1 from pg_extension where extname = 'vector'`))
if (installed.length === 0) {
  console.error(
    'pgvector is not installed on this database.\n' +
      "Ask a superuser to run:  CREATE EXTENSION vector;\n" +
      'then run this script again. Nothing has been changed.',
  )
  process.exit(1)
}

await app.db.execute(sql`alter table memories add column if not exists embedding vector(1536)`)
await app.db.execute(
  sql`create index if not exists memories_embedding_idx on memories using hnsw (embedding vector_cosine_ops) where valid_until is null and embedding is not null`,
)
console.log('column and index are in place')

const allTenants = await app.withSuperAdmin((superDb) =>
  superDb
    .select({ id: identity.tenants.id, name: identity.tenants.name })
    .from(identity.tenants)
    .where(eq(identity.tenants.status, 'active')),
)
for (const tenant of allTenants) {
  const pending = await app.withTenantContext(tenant.id, () =>
    app.db
      .select({ id: memories.id, title: memories.title, body: memories.body })
      .from(memories)
      .where(and(isNull(memories.validUntil), eq(memories.status, 'active'), sql`embedding is null`)),
  )
  if (pending.length === 0) {
    console.log(`${tenant.name}: nothing to embed`)
    continue
  }
  const vectors = await embedTexts(
    tenant.id,
    pending.map((note) => embeddableText(note.title, note.body)),
  )
  if (!vectors) {
    console.error(`${tenant.name}: no OpenAI-compatible provider configured — skipped ${pending.length} notes`)
    continue
  }
  let written = 0
  await app.withTenant(tenant.id, async () => {
    for (const [index, note] of pending.entries()) {
      const vector = vectors[index]
      if (!vector) continue
      await app.db.execute(sql`update memories set embedding = ${toVectorLiteral(vector)}::vector where id = ${note.id}`)
      written += 1
    }
  })
  console.log(`${tenant.name}: embedded ${written}/${pending.length} notes`)
}
process.exit(0)
