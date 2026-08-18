import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { runEvents } from '../db/schema'
import type { BunkhouseDb } from '../db/client'

type TenantDatabase = BunkhouseDb['db']
type AppendInput = {
  tenantId: string
  runId: string
  kind: (typeof runEvents.$inferInsert)['kind']
  payload: Record<string, unknown>
}

async function appendLocked(database: TenantDatabase, input: AppendInput): Promise<number> {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtext('bunkhouse.run_events'), hashtext(${input.runId}))`,
  )
  const [{ next } = { next: 0 }] = await database
    .select({ next: sql<number>`coalesce(max(${runEvents.seq}), -1) + 1`.mapWith(Number) })
    .from(runEvents)
    .where(eq(runEvents.runId, input.runId))
  await database.insert(runEvents).values({
    tenantId: input.tenantId,
    runId: input.runId,
    seq: next,
    kind: input.kind,
    payload: input.payload,
  })
  // NOTIFY is only a wake-up hint and is delivered on commit. Consumers
  // always cursor-read the table afterwards, so a dropped notification or a
  // reconnect cannot lose history.
  await database.execute(
    sql`select pg_notify('bunkhouse_run_events', ${JSON.stringify({ tenantId: input.tenantId, runId: input.runId, seq: next })})`,
  )
  return next
}

/**
 * Append one event under a per-run transaction lock.
 *
 * A live call and the approval executor can write the same run at once. Local
 * `seq++` counters in those two processes both chose 204 on the call that
 * exposed this, so the later trace row was lost to the unique index. The run
 * id is the serialization boundary: unrelated runs still append in parallel,
 * while every writer observes the actual latest sequence before inserting.
 */
export async function appendRunEvent(
  database: TenantDatabase,
  input: AppendInput,
): Promise<number> {
  return database.transaction((tx) => appendLocked(tx as unknown as TenantDatabase, input))
}

/** Append while the caller already holds the tenant transaction. */
export async function appendRunEventInTransaction(
  database: TenantDatabase,
  input: AppendInput,
): Promise<number> {
  return appendLocked(database, input)
}
