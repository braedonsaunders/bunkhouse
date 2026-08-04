import assert from 'node:assert/strict'
import pg from 'pg'

// The three database claims the README makes, asserted against a real,
// fully-migrated PostgreSQL: tenant rows are isolated by forced RLS, material
// ledgers reject UPDATE and DELETE at the database boundary, and a procedure
// revision a run pinned survives every later edit.
//
// Runs ONLY against a disposable database named by BUNKHOUSE_TEST_DB_URL —
// never the app's own BUNKHOUSE_DB_URL, and never by falling back to it.
// CI migrates a scratch postgres:16 service and points this at it; locally:
//
//   docker run -d --name bunkhouse-test-pg -e POSTGRES_PASSWORD=postgres \
//     -e POSTGRES_DB=bunkhouse_test -p 55437:5432 postgres:16
//   psql postgresql://postgres:postgres@localhost:55437/bunkhouse_test \
//     -c "create role bunkhouse_super login bypassrls"
//   BUNKHOUSE_DB_URL=postgresql://postgres:postgres@localhost:55437/bunkhouse_test \
//     pnpm --filter web db:migrate
//   BUNKHOUSE_TEST_DB_URL=postgresql://postgres:postgres@localhost:55437/bunkhouse_test \
//     pnpm --filter web test:db

const url = process.env.BUNKHOUSE_TEST_DB_URL
if (!url) {
  throw new Error(
    'BUNKHOUSE_TEST_DB_URL must name a disposable, migrated database. ' +
      'This suite creates and destroys data; it refuses to guess at a target.',
  )
}

const T1 = '11111111-1111-1111-1111-111111111111'
const T2 = '22222222-2222-2222-2222-222222222222'
const APP_ROLE = 'bunkhouse_claims_app'

const su = new pg.Client({ connectionString: url })
await su.connect()

/**
 * Mutable rows are wiped so the suite can run twice against one database.
 * Ledger rows are left where they land — they reject DELETE, which is the
 * claim under test, and the database is disposable by contract.
 */
async function reset() {
  for (const table of ['people', 'memories', 'procedures']) {
    await su.query(`delete from ${table} where tenant_id in ($1, $2)`, [T1, T2])
  }
}

// An unprivileged application role: owns nothing, so FORCE or not, every
// policy applies to it — the same posture the deployed app connects with.
await su.query(`
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
      create role ${APP_ROLE} login;
    end if;
  end $$;
  grant usage on schema public to ${APP_ROLE};
  grant select, insert, update, delete on all tables in schema public to ${APP_ROLE};
  grant usage, select on all sequences in schema public to ${APP_ROLE};
`)
await reset()
await su.query(
  `insert into tenants (id, name, slug) values ($1, 'Tenant One', 'claims-one'), ($2, 'Tenant Two', 'claims-two')
   on conflict (id) do nothing`,
  [T1, T2],
)

/** Run `fn` as the unprivileged role, optionally inside a tenant context. */
async function asApp<T>(tenantId: string | null, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  try {
    await c.query(`set role ${APP_ROLE}`)
    if (tenantId) await c.query(`set app.tenant_id = '${tenantId}'`)
    return await fn(c)
  } finally {
    await c.end()
  }
}

const count = async (c: pg.Client, sql: string) => Number((await c.query(sql)).rows[0].count)

// --- schema-wide guarantees --------------------------------------------------

// Every table that carries a tenant_id is under row-level security…
{
  const { rows } = await su.query(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id')
      and not c.relrowsecurity`)
  assert.deepEqual(rows, [], `tenant tables without RLS: ${rows.map((r) => r.relname).join(', ')}`)
}

// …and every RLS table is FORCEd, so the table owner is subject to it too.
// ENABLE without FORCE is how colleague_messages sat unprotected 0039→0048.
{
  const { rows } = await su.query(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity and not c.relforcerowsecurity`)
  assert.deepEqual(rows, [], `RLS enabled but not FORCEd: ${rows.map((r) => r.relname).join(', ')}`)
}

// --- tenant isolation --------------------------------------------------------

for (const [tenant, name] of [[T1, 'Agent One'], [T2, 'Agent Two']] as const) {
  await asApp(tenant, (c) =>
    c.query(
      `insert into people (tenant_id, kind, status, name, title, email)
       values ($1, 'agent', 'active', $2, 'Clerk', $3)`,
      [tenant, name, `${name.replaceAll(' ', '.').toLowerCase()}@claims.test`],
    ),
  )
  await asApp(tenant, (c) =>
    c.query(
      `insert into memories (tenant_id, scope, slug, title, body)
       values ($1, 'company', 'claims-fact', 'A fact', 'Belongs to ${name} only')`,
      [tenant],
    ),
  )
}

// Each tenant context sees exactly its own rows — an unqualified SELECT, the
// "forgotten WHERE clause", comes back already filtered.
await asApp(T1, async (c) => {
  assert.equal(await count(c, `select count(*) from people`), 1, 'T1 sees one person')
  const { rows } = await c.query(`select name from people`)
  assert.equal(rows[0].name, 'Agent One', 'and it is its own')
  assert.equal(await count(c, `select count(*) from memories`), 1, 'T1 sees one memory')
})
await asApp(T2, async (c) => {
  assert.equal(await count(c, `select count(*) from people`), 1, 'T2 sees one person')
  const { rows } = await c.query(`select name from people`)
  assert.equal(rows[0].name, 'Agent Two')
})

// No tenant context at all sees nothing — not everything.
await asApp(null, async (c) => {
  assert.equal(await count(c, `select count(*) from people`), 0, 'no context, no rows')
  assert.equal(await count(c, `select count(*) from memories`), 0)
  assert.equal(await count(c, `select count(*) from runs`), 0)
  // (`tenants` itself is the platform root — no tenant_id column, membership
  // enforced at the application layer — so it is deliberately not asserted here.)
})

// A tenant-wide UPDATE from T1 cannot reach T2's rows…
await asApp(T1, async (c) => {
  const res = await c.query(`update people set title = 'Renamed'`)
  assert.equal(res.rowCount, 1, 'an unqualified UPDATE touches only your own tenant')
})
await asApp(T2, async (c) => {
  const { rows } = await c.query(`select title from people`)
  assert.equal(rows[0].title, 'Clerk', "T2's row is untouched")
})

// …a DELETE cannot either…
await asApp(T1, async (c) => {
  const res = await c.query(`delete from memories`)
  assert.equal(res.rowCount, 1)
})
await asApp(T2, async (c) => {
  assert.equal(await count(c, `select count(*) from memories`), 1, "T2's memory survives T1's delete")
})

// …and WITH CHECK rejects writing a row into someone else's tenant outright.
await asApp(T1, async (c) => {
  await assert.rejects(
    c.query(
      `insert into people (tenant_id, kind, status, name, title, email)
       values ($1, 'agent', 'active', 'Intruder', 'Spy', 'spy@claims.test')`,
      [T2],
    ),
    (e: { code?: string }) => e.code === '42501',
    'inserting into another tenant violates the policy, not just convention',
  )
})

// --- append-only ledgers -----------------------------------------------------

// Evidence tables reject UPDATE and DELETE at the database boundary (SQLSTATE
// 55000), whoever asks — even a code path that bypasses the application.
// Random per invocation: appended evidence stays behind (see reset()), so a
// second run must not collide with the first run's unique keys.
const RID = crypto.randomUUID()
const MODEL = `claims-model-${RID.slice(0, 8)}`
const LEDGERS: [table: string, insert: string][] = [
  ['audit_log', `insert into audit_log (tenant_id, entity_type, action, summary) values ('${T1}', 'test', 'claims.check', 'evidence')`],
  ['run_events', `insert into run_events (tenant_id, run_id, seq, kind, payload) values ('${T1}', '${RID}', 1, 'message', '{"text":"hello"}')`],
  ['token_spend', `insert into token_spend (tenant_id, person_id, run_id, provider, model, input_tokens, output_tokens, cost_usd) values ('${T1}', '${RID}', '${RID}', 'anthropic', 'claude-sonnet-5', 100, 10, 0.0100)`],
  ['mail_messages', `insert into mail_messages (tenant_id, thread_id, direction, "from", subject, body_text, sent_at) values ('${T1}', '${RID}', 'outbound', '{"address":"a@claims.test"}', 'Hi', 'Body', now())`],
  ['procedure_revisions', `insert into procedure_revisions (tenant_id, procedure_id, version, body) values ('${T1}', '${RID}', 1, 'Step one.')`],
  ['memory_revisions', `insert into memory_revisions (tenant_id, note_id, rev, title, body, edited_by) values ('${T1}', '${RID}', 1, 'A fact', 'As first written', 'test')`],
  ['model_prices', `insert into model_prices (tenant_id, model, input_usd_per_mtok, output_usd_per_mtok, source) values ('${T1}', '${MODEL}', 1.0000, 2.0000, 'manual')`],
  ['cost_reconciliations', `insert into cost_reconciliations (tenant_id, provider, day, model, reported_usd, ledger_usd, drift_usd) values ('${T1}', 'anthropic', current_date, '${MODEL}', 1.0000, 1.0000, 0.0000)`],
  ['browser_steps', `insert into browser_steps (tenant_id, session_id, seq, action, detail) values ('${T1}', '${RID}', 1, 'click', '{}')`],
  ['call_turns', `insert into call_turns (tenant_id, session_id, seq, speaker, text, at_ms) values ('${T1}', '${RID}', 1, 'agent', 'Hello', 0)`],
  ['file_filings', `insert into file_filings (tenant_id, file_id, provider, status) values ('${T1}', '${RID}', 'smb', 'filed')`],
]

for (const [table, insert] of LEDGERS) {
  await asApp(T1, async (c) => {
    await c.query(insert)
    const appendOnly = (e: { code?: string }) => e.code === '55000'
    await assert.rejects(c.query(`update ${table} set tenant_id = tenant_id`), appendOnly, `${table} rejects UPDATE`)
    await assert.rejects(c.query(`delete from ${table}`), appendOnly, `${table} rejects DELETE`)
  })
}

// Even the BYPASSRLS handle cannot rewrite evidence — the trigger fires for
// every role short of one that drops it.
await assert.rejects(
  su.query(`update audit_log set summary = 'tampered' where tenant_id = '${T1}'`),
  (e: { code?: string }) => e.code === '55000',
  'the ledger guard binds the super role too',
)

// --- procedure pinning -------------------------------------------------------

// A run cites the revision it followed; publishing v2 must not change what v1
// said, and v1 must still be exactly retrievable.
{
  const PROC = crypto.randomUUID()
  await asApp(T1, async (c) => {
    await c.query(
      `insert into procedures (id, tenant_id, slug, title, current_version) values ($1, $2, 'dunning', 'Dunning cadence', 1)`,
      [PROC, T1],
    )
    await c.query(
      `insert into procedure_revisions (tenant_id, procedure_id, version, body) values ($1, $2, 1, 'Remind at day 15.')`,
      [T1, PROC],
    )
    // The run pins v1 in its evidence…
    await c.query(
      `insert into run_events (tenant_id, run_id, seq, kind, payload) values ($1, $2, 2, 'procedure_citation', '{"slug":"dunning","version":1}')`,
      [T1, RID],
    )
    // …then the procedure is edited: a NEW revision, never a rewrite.
    await c.query(
      `insert into procedure_revisions (tenant_id, procedure_id, version, body) values ($1, $2, 2, 'Remind at day 10.')`,
      [T1, PROC],
    )
    await c.query(`update procedures set current_version = 2 where id = $1`, [PROC])
    const v1 = await c.query(`select body from procedure_revisions where procedure_id = $1 and version = 1`, [PROC])
    assert.equal(v1.rows[0].body, 'Remind at day 15.', 'the pinned revision still says what it said')
    const cited = await c.query(
      `select payload from run_events where run_id = $1 and kind = 'procedure_citation'`,
      [RID],
    )
    assert.equal(cited.rows[0].payload.version, 1, "the run's citation still names v1")
    await assert.rejects(
      c.query(`update procedure_revisions set body = 'Remind at day 5.' where procedure_id = $1 and version = 1`, [PROC]),
      (e: { code?: string }) => e.code === '55000',
      'history cannot be edited to match the present',
    )
  })
}

await reset()
await su.end()
console.log('db-claims: forced RLS isolation, append-only ledgers, and procedure pinning — verified against PostgreSQL')
