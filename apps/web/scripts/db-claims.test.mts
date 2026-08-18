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

// A login maps to at most one human in each tenant. The same global account
// may legitimately represent a person in another workspace, while an agent
// can never be mistaken for an authenticated human.
{
  const USER = crypto.randomUUID()
  await su.query(
    `insert into users (id, name, email) values ($1, 'Claims Human', $2)`,
    [USER, `claims-human-${USER.slice(0, 8)}@example.test`],
  )
  await asApp(T1, (c) =>
    c.query(
      `insert into people (tenant_id, kind, status, name, title, email, user_id)
       values ($1, 'human', 'active', 'Linked Human', 'Owner', $2, $3)`,
      [T1, `linked-${USER.slice(0, 8)}@example.test`, USER],
    ),
  )
  await asApp(T1, async (c) => {
    await assert.rejects(
      c.query(
        `insert into people (tenant_id, kind, status, name, title, email, user_id)
         values ($1, 'human', 'active', 'Duplicate Human', 'Owner', $2, $3)`,
        [T1, `duplicate-${USER.slice(0, 8)}@example.test`, USER],
      ),
      (e: { code?: string }) => e.code === '23505',
      'one workspace account cannot link to two People records',
    )
    await assert.rejects(
      c.query(
        `insert into people (tenant_id, kind, status, name, title, email, user_id)
         values ($1, 'agent', 'active', 'Not Human', 'Agent', $2, $3)`,
        [T1, `agent-${USER.slice(0, 8)}@example.test`, USER],
      ),
      (e: { code?: string }) => e.code === '23514',
      'an agent cannot link to a login account',
    )
  })
  await asApp(T2, (c) =>
    c.query(
      `insert into people (tenant_id, kind, status, name, title, email, user_id)
       values ($1, 'human', 'active', 'Other Workspace Human', 'Owner', $2, $3)`,
      [T2, `other-${USER.slice(0, 8)}@example.test`, USER],
    ),
  )
}

// --- append-only ledgers -----------------------------------------------------

// Evidence tables reject UPDATE and DELETE at the database boundary (SQLSTATE
// 55000), whoever asks — even a code path that bypasses the application.
// Random per invocation: appended evidence stays behind (see reset()), so a
// second run must not collide with the first run's unique keys.
const RID = crypto.randomUUID()
const BAD_ATTEMPT = crypto.randomUUID()
const MODEL = `claims-model-${RID.slice(0, 8)}`
await asApp(T1, (c) =>
  c.query(
    `insert into runs (id, tenant_id, person_id, trigger) values ($1, $2, $1, '{"type":"manual","requestedBy":"claims"}')`,
    [RID, T1],
  ),
)
const LEDGERS: [table: string, insert: string][] = [
  ['audit_log', `insert into audit_log (tenant_id, entity_type, action, summary) values ('${T1}', 'test', 'claims.check', 'evidence')`],
  ['run_events', `insert into run_events (tenant_id, run_id, seq, kind, payload) values ('${T1}', '${RID}', 1, 'message', '{"text":"hello"}')`],
  ['run_attempts', `insert into run_attempts (id, tenant_id, run_id, owner, fence) values ('${RID}', '${T1}', '${RID}', 'claims-worker', 1)`],
  ['run_attempt_events', `insert into run_attempt_events (tenant_id, attempt_id, seq, kind) values ('${T1}', '${RID}', 1, 'claimed')`],
  ['external_effect_intents', `insert into external_effect_intents (id, tenant_id, run_id, provenance_kind, attempt_id, kind, idempotency_key, request) values ('${RID}', '${T1}', '${RID}', 'run_attempt', '${RID}', 'external_email:send_email', 'claims:${RID}', '{}')`],
  ['external_effect_events', `insert into external_effect_events (tenant_id, effect_id, seq, kind, payload) values ('${T1}', '${RID}', 1, 'completed', '{"result":{"sent":true}}')`],
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

await asApp(T1, async (c) => {
  await assert.rejects(
    c.query(
      `insert into external_effect_intents
         (tenant_id, run_id, provenance_kind, attempt_id, kind, idempotency_key, request)
       values ($1, $2, 'run_attempt', $3, 'record_write:test', $4, '{}')`,
      [T1, RID, BAD_ATTEMPT, `bad-provenance:${BAD_ATTEMPT}`],
    ),
    (error: { code?: string }) => error.code === '23503',
    'an effect intent must name a real same-run execution authority',
  )
})

await asApp(T2, async (c) => {
  await assert.rejects(
    c.query(
      `insert into external_effect_events (tenant_id, effect_id, seq, kind, payload)
       values ($1, $2, 2, 'completed', '{"result":{"forged":true}}')`,
      [T2, RID],
    ),
    (error: { code?: string }) => error.code === '23503',
    'an effect event cannot point at another tenant\'s intent',
  )
})

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

// --- membership → People reconciliation ------------------------------------

// The production repair path is tested against PostgreSQL too: it must adopt
// the seeded manager in place, retain every report pointing at that row,
// suspend the obsolete credentialless membership, and be idempotent.
{
  const TENANT = crypto.randomUUID()
  const LEGACY_USER = crypto.randomUUID()
  const OWNER_USER = crypto.randomUUID()
  const LEGACY_PERSON = crypto.randomUUID()
  const REPORT = crypto.randomUUID()
  const ownerEmail = `real-owner-${OWNER_USER.slice(0, 8)}@example.test`
  await su.query(`insert into tenants (id, name, slug) values ($1, 'Reconcile Co', $2)`, [
    TENANT,
    `reconcile-${TENANT.slice(0, 8)}`,
  ])
  await su.query(
    `insert into users (id, name, email, is_super_admin)
     values ($1, 'Demo Owner', 'owner@bunkhouse.local', false), ($2, 'Owner', $3, true)`,
    [LEGACY_USER, OWNER_USER, ownerEmail],
  )
  await su.query(
    `insert into accounts (user_id, account_id, provider_id, password)
     values ($1, $2, 'credential', 'test-only')`,
    [OWNER_USER, OWNER_USER],
  )
  await su.query(
    `insert into tenant_users (tenant_id, user_id, display_name, status, joined_at)
     values ($1, $2, 'Demo Owner', 'active', now()), ($1, $3, 'Owner', 'active', now())`,
    [TENANT, LEGACY_USER, OWNER_USER],
  )
  await su.query(
    `insert into people (id, tenant_id, kind, status, name, title, email)
     values ($1, $2, 'human', 'active', 'Demo Owner', 'Owner', 'owner@bunkhouse.local')`,
    [LEGACY_PERSON, TENANT],
  )
  await su.query(
    `insert into people (id, tenant_id, kind, status, name, title, email, reports_to_id)
     values ($1, $2, 'agent', 'active', 'Marla', 'Assistant', $3, $4)`,
    [REPORT, TENANT, `marla-${REPORT.slice(0, 8)}@example.test`, LEGACY_PERSON],
  )

  process.env.BUNKHOUSE_DB_URL = process.env.BUNKHOUSE_TEST_APP_URL ?? url
  process.env.BUNKHOUSE_SUPER_URL = process.env.BUNKHOUSE_TEST_SUPER_URL ?? url
  const { ensurePersonForMembership } = await import('../src/lib/person-accounts.ts')
  const first = await ensurePersonForMembership({ tenantId: TENANT, userId: OWNER_USER, adoptLegacyOwner: true })
  const second = await ensurePersonForMembership({ tenantId: TENANT, userId: OWNER_USER, adoptLegacyOwner: true })
  assert.equal(first.personId, LEGACY_PERSON, 'the seeded manager row is adopted in place')
  assert.equal(second.personId, LEGACY_PERSON, 'reconciliation is idempotent')

  const linked = await su.query(
    `select name, email, user_id from people where id = $1`,
    [LEGACY_PERSON],
  )
  assert.deepEqual(
    linked.rows[0],
    { name: 'Owner', email: ownerEmail, user_id: OWNER_USER },
    'the manager now carries the real owner identity',
  )
  const report = await su.query(`select reports_to_id from people where id = $1`, [REPORT])
  assert.equal(report.rows[0].reports_to_id, LEGACY_PERSON, 'existing reporting lines survive adoption')
  const oldMembership = await su.query(
    `select status from tenant_users where tenant_id = $1 and user_id = $2`,
    [TENANT, LEGACY_USER],
  )
  assert.equal(oldMembership.rows[0].status, 'suspended', 'the credentialless demo membership is suspended')

  const { db: testDb } = await import('../src/db/client.ts')
  const {
    callSessions: testCallSessions,
    chatThreads: testChatThreads,
    deskEvents: testDeskEvents,
    deskSessions: testDeskSessions,
    runs: testRuns,
  } = await import('../src/db/schema/index.ts')
  const { externalEffectStore, finalizeRunAttempt, reconcileExternalEffect, runExecutionLeaseStore } = await import('../src/lib/run-execution.ts')
  const { chatWorkSurface } = await import('../src/lib/chat-work-surface.ts')
  const { appendRunEvent } = await import('../src/lib/run-events.ts')
  const { closeRunEventNotifications, waitForRunEventWake } = await import('../src/lib/run-event-notifications.ts')

  // The application store—not only the schema—must enforce one executor and
  // deterministic external-effect replay on the real PostgreSQL boundary.
  await testDb().withTenantContext(TENANT, async () => {
    const runId = crypto.randomUUID()
    await testDb().db.insert(testRuns).values({
      id: runId,
      tenantId: TENANT,
      personId: REPORT,
      status: 'running',
      trigger: { type: 'manual', requestedBy: 'claims' },
    })
    const leases = runExecutionLeaseStore(TENANT)
    const first = await leases.claim({ runId, owner: 'worker-one', leaseMs: 60_000, now: new Date() })
    assert.ok(first, 'the eligible run is claimed')
    assert.equal(
      await leases.claim({ runId, owner: 'worker-two', leaseMs: 60_000, now: new Date() }),
      null,
      'a second executor cannot claim the live fence',
    )
    const effects = externalEffectStore(TENANT)
    const intent = {
      tenantId: TENANT,
      runId,
      attemptId: first.attemptId,
      kind: 'external_email:send_email',
      idempotencyKey: `claims-effect:${runId}`,
      request: { b: 2, a: 1 },
      at: new Date(),
    }
    const claimed = await effects.claim(intent)
    assert.equal(claimed.disposition, 'execute')
    await assert.rejects(
      reconcileExternalEffect({
        tenantId: TENANT,
        effectId: claimed.effectId,
        actorUserId: OWNER_USER,
        resolution: 'retry',
        note: 'This must wait until the original execution settles.',
      }),
      /active execution/,
      'an operator cannot race an original in-flight effect with manual evidence',
    )
    await effects.append(claimed.effectId, { kind: 'completed', at: new Date(), result: { sent: true } })
    const replay = await effects.claim({ ...intent, request: { a: 1, b: 2 } })
    assert.deepEqual(replay.disposition === 'completed' ? replay.result : null, { sent: true })
    await assert.rejects(
      effects.append(claimed.effectId, { kind: 'ambiguous', at: new Date(), error: 'too late' }),
      /already terminal/,
      'authoritative effect completion rejects every later outcome',
    )

    const uncertainIntent = {
      ...intent,
      idempotencyKey: `claims-effect-uncertain:${runId}`,
      request: { message: 'may have reached the destination' },
    }
    const uncertainClaim = await effects.claim(uncertainIntent)
    assert.equal(uncertainClaim.disposition, 'execute')
    assert.equal((await effects.claim(uncertainIntent)).disposition, 'uncertain')
    await effects.append(uncertainClaim.effectId, {
      kind: 'failed',
      at: new Date(),
      error: 'The adapter proved the request was rejected before application.',
    })
    const retry = await effects.claim(uncertainIntent)
    assert.equal(retry.disposition, 'execute')
    assert.equal(retry.disposition === 'execute' ? retry.retry : false, true)
    await effects.append(uncertainClaim.effectId, { kind: 'retry_started', at: new Date() })
    await assert.rejects(
      reconcileExternalEffect({
        tenantId: TENANT,
        effectId: uncertainClaim.effectId,
        actorUserId: OWNER_USER,
        resolution: 'completed',
        note: 'This must wait until the active retry settles.',
      }),
      /active execution/,
      'an operator cannot race an in-flight retry with a manual outcome',
    )
    await effects.append(uncertainClaim.effectId, {
      kind: 'ambiguous',
      at: new Date(),
      error: 'Connection ended before acknowledgement.',
    })
    assert.equal(
      await finalizeRunAttempt(
        TENANT,
        first,
        { status: 'completed', finishedAt: new Date(), transcript: null, waiting: null, summary: 'done' },
        'completed',
      ),
      true,
      'run and attempt finish under one fence',
    )
    await reconcileExternalEffect({
      tenantId: TENANT,
      effectId: uncertainClaim.effectId,
      actorUserId: OWNER_USER,
      resolution: 'completed',
      note: 'The destination audit log now contains the exact action.',
    })
    const reconciled = await effects.claim(uncertainIntent)
    assert.deepEqual(reconciled.disposition === 'completed' ? reconciled.result : null, { reconciled: true })
    const completedReconciliation = await su.query(
      `select before, after from audit_log where entity_type = 'external_effect' and entity_id = $1 order by created_at`,
      [uncertainClaim.effectId],
    )
    assert.deepEqual(
      completedReconciliation.rows.map((row) => [row.before.status, row.after.status]),
      [['ambiguous', 'reconciled']],
      'confirming completion appends matching effect and audit evidence',
    )
    const finalized = await su.query(`select status, lease_owner from runs where id = $1`, [runId])
    assert.deepEqual(finalized.rows[0], { status: 'completed', lease_owner: null })
    assert.equal(
      await leases.renew(first, { leaseMs: 60_000, now: new Date() }),
      null,
      'a closed fence cannot be renewed',
    )

    const operatorRetryIntent = {
      ...intent,
      idempotencyKey: `claims-effect-operator-retry:${runId}`,
      request: { message: 'independently confirmed absent' },
    }
    const operatorRetryClaim = await effects.claim(operatorRetryIntent)
    assert.equal(operatorRetryClaim.disposition, 'execute')
    await reconcileExternalEffect({
      tenantId: TENANT,
      effectId: operatorRetryClaim.effectId,
      actorUserId: OWNER_USER,
      resolution: 'retry',
      note: 'The destination audit log contains no matching action.',
    })
    const operatorRetry = await effects.claim(operatorRetryIntent)
    assert.equal(operatorRetry.disposition, 'execute')
    assert.equal(operatorRetry.disposition === 'execute' ? operatorRetry.retry : false, true)
    const retryReconciliation = await su.query(
      `select before, after from audit_log where entity_type = 'external_effect' and entity_id = $1 order by created_at`,
      [operatorRetryClaim.effectId],
    )
    assert.deepEqual(
      retryReconciliation.rows.map((row) => [row.before.status, row.after.status]),
      [['intended', 'failed']],
      'confirming non-completion appends matching effect and audit evidence',
    )

    const takeoverRunId = crypto.randomUUID()
    await testDb().db.insert(testRuns).values({
      id: takeoverRunId,
      tenantId: TENANT,
      personId: REPORT,
      status: 'running',
      trigger: { type: 'manual', requestedBy: 'claims' },
    })
    const expiredLease = await leases.claim({
      runId: takeoverRunId,
      owner: 'worker-that-crashed',
      leaseMs: 1,
      now: new Date('2026-08-17T12:00:00.000Z'),
    })
    assert.ok(expiredLease)
    assert.equal(
      await leases.renew(expiredLease, { leaseMs: 60_000, now: new Date('2026-08-17T12:00:01.000Z') }),
      null,
      'an owner cannot revive its authority after the lease deadline',
    )
    const replacementLease = await leases.claim({
      runId: takeoverRunId,
      owner: 'replacement-worker',
      leaseMs: 60_000,
      now: new Date('2026-08-17T12:01:00.000Z'),
    })
    assert.ok(replacementLease, 'an expired lease can be replaced')
    const superseded = await su.query(
      `select kind, detail from run_attempt_events where attempt_id = $1 order by seq desc limit 1`,
      [expiredLease.attemptId],
    )
    assert.equal(superseded.rows[0].kind, 'lease_lost', 'takeover closes the crashed attempt append-only')
    assert.equal(superseded.rows[0].detail.replacedByAttemptId, replacementLease.attemptId)
    assert.equal(
      await finalizeRunAttempt(
        TENANT,
        replacementLease,
        { status: 'completed', finishedAt: new Date(), transcript: null, waiting: null, summary: 'recovered' },
        'completed',
      ),
      true,
    )

    const cancelledRunId = crypto.randomUUID()
    await testDb().db.insert(testRuns).values({
      id: cancelledRunId,
      tenantId: TENANT,
      personId: REPORT,
      status: 'running',
      trigger: { type: 'manual', requestedBy: 'claims' },
    })
    const cancelledLease = await leases.claim({
      runId: cancelledRunId,
      owner: 'worker-cancelled',
      leaseMs: 60_000,
      now: new Date(),
    })
    assert.ok(cancelledLease)
    await su.query(`update runs set status = 'cancelled' where id = $1`, [cancelledRunId])
    assert.equal(
      await finalizeRunAttempt(
        TENANT,
        cancelledLease,
        { status: 'completed', finishedAt: new Date(), transcript: null, waiting: null, summary: 'too late' },
        'completed',
      ),
      true,
      'a racing cancellation still closes the owned attempt',
    )
    const cancelled = await su.query(`select status, lease_owner from runs where id = $1`, [cancelledRunId])
    assert.deepEqual(cancelled.rows[0], { status: 'cancelled', lease_owner: null })
    const terminalAttempt = await su.query(
      `select kind from run_attempt_events where attempt_id = $1 order by seq desc limit 1`,
      [cancelledLease.attemptId],
    )
    assert.equal(terminalAttempt.rows[0].kind, 'cancelled')

    const wakeController = new AbortController()
    const wake = waitForRunEventWake(runId, wakeController.signal)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await appendRunEvent(testDb().db, {
      tenantId: TENANT,
      runId,
      kind: 'message',
      payload: { text: 'wake proof' },
    })
    await Promise.race([
      wake,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('run-event wake timed out')), 2_000)),
    ])
    wakeController.abort()

    const threadId = crypto.randomUUID()
    const surfaceRunId = crypto.randomUUID()
    const deskSessionId = crypto.randomUUID()
    await testDb().db.insert(testChatThreads).values({
      id: threadId,
      tenantId: TENANT,
      personId: REPORT,
      userId: OWNER_USER,
    })
    await testDb().db.insert(testRuns).values({
      id: surfaceRunId,
      tenantId: TENANT,
      personId: REPORT,
      status: 'running',
      trigger: { type: 'chat', conversationId: `web:${threadId}` },
    })
    await testDb().db.insert(testDeskSessions).values({
      id: deskSessionId,
      tenantId: TENANT,
      personId: REPORT,
      runId: surfaceRunId,
      status: 'active',
    })
    await testDb().db.insert(testDeskEvents).values({
      tenantId: TENANT,
      sessionId: deskSessionId,
      seq: 0,
      kind: 'navigate',
      detail: { title: 'Vendor portal', url: 'https://vendor.example.test' },
    })
    assert.equal((await chatWorkSurface(TENANT, threadId)).kind, 'browser', 'browser work is promoted into chat')
    await testDb().db.insert(testDeskEvents).values({
      tenantId: TENANT,
      sessionId: deskSessionId,
      seq: 1,
      kind: 'shell_command',
      detail: { command: 'process-invoices', exitCode: 0 },
    })
    assert.equal((await chatWorkSurface(TENANT, threadId)).kind, 'activity', 'newer headless work replaces a stale browser frame')
    await testDb().db.insert(testCallSessions).values({
      tenantId: TENANT,
      personId: REPORT,
      runId: surfaceRunId,
      room: `claims-call-${surfaceRunId}`,
      direction: 'web',
      counterparty: { name: 'Claims caller' },
      status: 'active',
    })
    assert.equal((await chatWorkSurface(TENANT, threadId)).kind, 'call', 'an active call is visible without a desktop')
    await testDb().db.insert(testDeskEvents).values({
      tenantId: TENANT,
      sessionId: deskSessionId,
      seq: 2,
      kind: 'screen_open',
      detail: { reason: 'The task requires a graphical application.' },
    })
    assert.equal((await chatWorkSurface(TENANT, threadId)).kind, 'desktop', 'an open screen takes over the work stage')
    await testDb().db.insert(testDeskEvents).values({
      tenantId: TENANT,
      sessionId: deskSessionId,
      seq: 3,
      kind: 'screen_close',
      detail: {},
    })
    assert.equal((await chatWorkSurface(TENANT, threadId)).kind, 'call', 'closing the screen returns to the active call')
  })

  await closeRunEventNotifications()

  await testDb().pool.end()
  await testDb().superPool.end()
  await su.query(`delete from people where tenant_id = $1 and id = $2`, [TENANT, REPORT])
  await su.query(`delete from people where tenant_id = $1`, [TENANT])
  await su.query(`delete from tenant_users where tenant_id = $1`, [TENANT])
  await su.query(`delete from accounts where user_id in ($1, $2)`, [LEGACY_USER, OWNER_USER])
  await su.query(`delete from users where id in ($1, $2)`, [LEGACY_USER, OWNER_USER])
  await su.query(`delete from tenants where id = $1`, [TENANT])
}

await reset()
await su.end()
console.log('db-claims: RLS, immutable ledgers, pinned procedures, and person/account reconciliation — verified')
