import 'server-only'
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { chatDispatchEvents, chatDispatches, chatMessages, chatThreads, runs } from '../db/schema'
import { db } from '../db/client'
import { conversationIdFor } from './chat-threads'

/**
 * Saying something to an agent that is already working.
 *
 * A conversation is not turn-locked in practice. Somebody watching an agent head
 * down the wrong path says so straight away — "not that coin, the other one" —
 * and a queue is the wrong answer to that: the correction waited until the whole
 * turn finished, by which point the agent had spent the intervening minutes
 * doing the thing nobody wanted any more.
 *
 * The first attempt at "send now" tried to REORDER the queue, and could never
 * have worked: `enforce_chat_dispatch_change` (migration 0063) rejects any change
 * to `position` outright, because FIFO order is an invariant of the queue rather
 * than a preference. The database was right and the feature was wrong. Order is
 * not the problem being solved here — latency is.
 *
 * So a steered message is not reordered, it is DELIVERED: its words go into the
 * transcript where the person put them, the running loop picks them up before its
 * next step, and the queue entry stops existing because it is never going to need
 * a turn of its own.
 */

/** A run that has not reached a terminal state: still working, or parked on a wait. */
const LIVE_RUN_STATUSES = ['running', 'waiting_approval', 'waiting_reply', 'waiting_credential'] as const

/**
 * Hand a queued message to the turn already in progress.
 *
 * Returns `false` when there is nothing to steer, and the caller falls back to
 * the ordinary queue — which is not a failure: with no turn running, the drain
 * starts the head of the queue within the second, so there is nothing to jump.
 */
export async function steerRunningTurn(args: {
  tenantId: string
  threadId: string
  dispatchId: string
  userId: string
}): Promise<{ steered: boolean }> {
  const app = db()
  return app.withTenant(args.tenantId, () =>
    app.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof app.db
      // The same per-thread lock claiming uses: a turn must not finish between
      // deciding to steer it and recording that we did.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('bunkhouse.chat_dispatch'), hashtext(${args.threadId}))`,
      )
      const [dispatch] = await tx
        .select({ id: chatDispatches.id, body: chatDispatches.body, status: chatDispatches.status, userId: chatDispatches.userId })
        .from(chatDispatches)
        .where(eq(chatDispatches.id, args.dispatchId))
        .limit(1)
      if (!dispatch) throw new Error('That queued message no longer exists.')
      if (dispatch.userId !== args.userId) throw new Error('That queued message belongs to someone else.')
      if (dispatch.status !== 'queued') throw new Error('That message is no longer waiting to be sent.')

      const [live] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            sql`${runs.trigger}->>'conversationId' = ${conversationIdFor(args.threadId)}`,
            inArray(runs.status, [...LIVE_RUN_STATUSES]),
          ),
        )
        .orderBy(desc(runs.startedAt))
        .limit(1)
      if (!live) return { steered: false }

      // The words go in where the person put them, as their own turn. The run
      // reads them from here — the transcript is the carrier, so there is no
      // second copy of the message to disagree with it.
      const [{ nextSeq } = { nextSeq: 0 }] = await tx
        .select({ nextSeq: sql<number>`coalesce(max(${chatMessages.seq}), -1) + 1`.mapWith(Number) })
        .from(chatMessages)
        .where(eq(chatMessages.threadId, args.threadId))
      await tx.insert(chatMessages).values({
        tenantId: args.tenantId,
        threadId: args.threadId,
        seq: nextSeq,
        role: 'user',
        body: dispatch.body,
        dispatchId: dispatch.id,
      })
      await tx
        .update(chatThreads)
        .set({ lastMessageAt: new Date(), updatedAt: new Date() })
        .where(eq(chatThreads.id, args.threadId))

      // `cancelled`, and accurately so: this dispatch asked for a turn of its
      // own and is never going to get one. The event beside it is what says the
      // words were delivered rather than discarded — the status alone would read
      // as "thrown away", which is the opposite of what happened.
      await tx
        .update(chatDispatches)
        .set({ status: 'cancelled', finishedAt: new Date(), updatedAt: new Date(), updatedBy: args.userId })
        .where(and(eq(chatDispatches.id, dispatch.id), eq(chatDispatches.status, 'queued')))
      const [{ nextEventSeq } = { nextEventSeq: 0 }] = await tx
        .select({ nextEventSeq: sql<number>`coalesce(max(${chatDispatchEvents.seq}), -1) + 1`.mapWith(Number) })
        .from(chatDispatchEvents)
        .where(eq(chatDispatchEvents.dispatchId, dispatch.id))
      await tx.insert(chatDispatchEvents).values({
        tenantId: args.tenantId,
        dispatchId: dispatch.id,
        seq: nextEventSeq,
        kind: 'steered',
        detail: { runId: live.id },
        actorId: args.userId,
      })
      return { steered: true }
    }),
  )
}

/**
 * What the person has said since this run started, exactly once.
 *
 * Called by the loop between steps. `runs.consumed_message_ids` is the same
 * ledger a resumed run uses to avoid re-reading a reply it has already answered;
 * appending here is what makes delivery at-most-once, so a long run does not meet
 * the same correction on every step and talk itself in circles.
 */
export async function takePendingSteer(args: {
  tenantId: string
  runId: string
  threadId: string
}): Promise<string[]> {
  const app = db()
  return app.withTenant(args.tenantId, () =>
    app.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof app.db
      const [run] = await tx
        .select({ startedAt: runs.startedAt, consumed: runs.consumedMessageIds })
        .from(runs)
        .where(eq(runs.id, args.runId))
        .limit(1)
      if (!run) return []
      const consumed = run.consumed ?? []
      const rows = await tx
        .select({ id: chatMessages.id, body: chatMessages.body })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.threadId, args.threadId),
            eq(chatMessages.role, 'user'),
            // Strictly after the run began: the turn's own prompt is already in
            // its context and must not arrive a second time as a correction.
            gt(chatMessages.at, run.startedAt),
            ...(consumed.length > 0 ? [sql`${chatMessages.id} <> all(${consumed}::uuid[])`] : []),
          ),
        )
        .orderBy(asc(chatMessages.seq))
      if (rows.length === 0) return []
      await tx
        .update(runs)
        .set({ consumedMessageIds: sql`${runs.consumedMessageIds} || ${rows.map((row) => row.id)}::uuid[]` })
        .where(eq(runs.id, args.runId))
      return rows.map((row) => row.body)
    }),
  )
}
