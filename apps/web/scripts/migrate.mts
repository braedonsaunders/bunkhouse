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
      await client.query(body.replaceAll('--> statement-breakpoint', ''))
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
