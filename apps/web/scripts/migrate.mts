import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

// Tracked, idempotent migration apply against the shared Patroni cluster.
// Rules learned in production: every applied file gets an _applied_migrations
// row in the same session, and a re-run must be a no-op.

const dir = fileURLToPath(new URL('../../../migrations/', import.meta.url))
const url = process.env.BUNKHOUSE_DB_URL
if (!url) throw new Error('BUNKHOUSE_DB_URL must be set (run with --env-file=.env.local)')

/**
 * Tenant tables carry FORCE ROW LEVEL SECURITY, which applies to the table
 * owner as well — and migrations connect as the owner with no app.tenant_id
 * set. Every row is therefore invisible, so a migration that backfills data
 * updates nothing, reports success, and leaves the schema change half-applied
 * with no error anywhere. DDL is unaffected, which is why this has never been
 * noticed: `alter table` sees the table, `update` sees none of its rows.
 *
 * So the enforcement is lifted for the duration of one migration's transaction
 * and put back before it commits. It is the same connection, the same
 * transaction, and the owner of the tables either way; nothing outside this
 * function ever observes RLS switched off, and a failed migration rolls the
 * toggle back with everything else.
 */
async function withoutForcedRls<T>(client: pg.Client, work: () => Promise<T>): Promise<T> {
  const { rows } = await client.query<{ ident: string }>(
    `select format('%I.%I', n.nspname, c.relname) as ident
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.relforcerowsecurity and c.relkind = 'r' and n.nspname = 'public'`,
  )
  const tables = rows.map((r) => r.ident)
  if (tables.length === 0) return work()
  for (const table of tables) await client.query(`alter table ${table} no force row level security`)
  try {
    return await work()
  } finally {
    // Restoring inside the transaction means a rollback cannot leave a tenant
    // table unprotected, and a commit never lands one either.
    for (const table of tables) await client.query(`alter table ${table} force row level security`)
  }
}

const client = new pg.Client({ connectionString: url })
await client.connect()
try {
  await client.query(
    `create table if not exists _applied_migrations (
       filename text primary key,
       sha256 text not null,
       applied_at timestamptz not null default now()
     )`,
  )
  const applied = new Set(
    (await client.query<{ filename: string }>('select filename from _applied_migrations')).rows.map(
      (r) => r.filename,
    ),
  )
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip  ${file}`)
      continue
    }
    const body = readFileSync(`${dir}${file}`, 'utf8')
    const sha = createHash('sha256').update(body).digest('hex')
    await client.query('begin')
    try {
      // Drizzle emits `--> statement-breakpoint` separators; pg can run the
      // whole buffer as one multi-statement query once they're stripped.
      await withoutForcedRls(client, () => client.query(body.replaceAll('--> statement-breakpoint', '')))
      await client.query('insert into _applied_migrations (filename, sha256) values ($1, $2)', [
        file,
        sha,
      ])
      await client.query('commit')
      console.log(`apply ${file}`)
    } catch (error) {
      await client.query('rollback')
      throw new Error(`migration ${file} failed: ${(error as Error).message}`)
    }
  }
  // bunkhouse_super is BYPASSRLS but not superuser — it needs object grants,
  // renewed after every migration so new tables are covered.
  await client.query(`
    grant usage on schema public to bunkhouse_super;
    grant all on all tables in schema public to bunkhouse_super;
    grant all on all sequences in schema public to bunkhouse_super;
    alter default privileges in schema public grant all on tables to bunkhouse_super;
    alter default privileges in schema public grant all on sequences to bunkhouse_super;
  `)
  console.log('grants refreshed for bunkhouse_super')
} finally {
  await client.end()
}
