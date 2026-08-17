import 'server-only'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { generateText } from 'ai'
import { getModel } from '@braedonsaunders/appkit-ai'
import { memories, people } from '../db/schema'
import { db } from '../db/client'
import { resolveAgentAiConfig } from './ai'
import { createNote } from './memory'

/**
 * Sleeping on it: turning a day of raw episodes into the few things worth
 * keeping.
 *
 * An append-only logbook is the right shape for a LEDGER and the wrong shape
 * for a memory. One agent wrote 195 notes in a single day — every attempt,
 * every dead end, every status update — and every one of them was then read
 * back into the top of every subsequent run. It compounds twice over: the
 * logbook grows without limit, and each run costs more to start than the last
 * because it is re-reading a longer diary of things that no longer matter.
 *
 * What a person does with a day like that is not remember all of it. They keep
 * a handful of conclusions and let the rest go. So does this: the raw episodes
 * are read once, rewritten into the few durable facts they actually amount to,
 * and then expired — never deleted, so the ledger is intact and the history is
 * auditable, but out of the way of everything that reads memory to work.
 *
 * Three deliberate limits, because a consolidation that goes wrong quietly is
 * worse than none:
 *
 *   - only EPISODES, the record of what happened. A fact, a procedure or a
 *     reflection is already a conclusion, and pinned notes are what a human
 *     curated on purpose. None of those are touched.
 *   - only an agent's own scope. The company's shared memory has its own
 *     gardener with human review, and it should keep it.
 *   - only when there are enough to be worth it, oldest first, in bounded
 *     batches — so this never becomes an expensive job of its own.
 */

/** Below this many live episodes, a logbook is not a problem to solve. */
const CONSOLIDATE_ABOVE = 25

/** How many are read in one pass. Bounded: this is a background job. */
const BATCH = 40

/** Episodes younger than this are still current; they get to stay raw. */
const SETTLE_HOURS = 6

const PROMPT = `These are raw entries from one AI colleague's own logbook — what it did and what happened, written as it went.

Rewrite them into the few things that are still worth knowing tomorrow. Not a summary of the day: the durable conclusions a capable person would carry forward, in their own words, as if writing for themselves.

Rules:
- At most five notes. Usually fewer. Two good ones beat five padded.
- Each is a standalone statement of something that is TRUE, not a story of what happened. "The customer inbox sweep needs a connected mailbox, which this agent does not have" — not "tried the sweep again at 14:03 and it failed".
- Drop everything transient: attempts, retries, status updates, acknowledgements, anything already superseded by a later entry.
- Drop anything that was only true because something was temporarily broken, unless the breakage itself is the lasting fact.
- Keep concrete details that matter — names, addresses, numbers, dates — and lose the rest.
- If the entries genuinely amount to nothing worth keeping, return an empty list. That is a good outcome, not a failure.

Return JSON only: {"notes":[{"title":"...","body":"...","kind":"fact"|"reflection"|"procedure"}]}`

export type Consolidation = { agent: string; read: number; kept: number }

/**
 * One pass for one company. Assumes nothing about scope — it opens its own.
 */
export async function consolidateMemories(tenantId: string): Promise<Consolidation[]> {
  const app = db()
  const agents = await app.withTenantContext(tenantId, () =>
    app.db.select({ id: people.id, name: people.name }).from(people).where(eq(people.kind, 'agent')),
  )

  const done: Consolidation[] = []
  for (const agent of agents) {
    const config = await resolveAgentAiConfig(tenantId, agent.id)
    const model = config ? (getModel(config, 'smart') ?? getModel(config, 'fast')) : null
    if (!model) continue

    const consolidated = await app.withTenant(tenantId, async () => {
      const live = await app.db
        .select({ id: memories.id, title: memories.title, body: memories.body, createdAt: memories.createdAt })
        .from(memories)
        .where(
          and(
            eq(memories.scope, 'agent'),
            eq(memories.personId, agent.id),
            eq(memories.kind, 'episode'),
            eq(memories.pinned, false),
            eq(memories.status, 'active'),
            isNull(memories.validUntil),
            sql`${memories.createdAt} < now() - interval '${sql.raw(String(SETTLE_HOURS))} hours'`,
          ),
        )
        .orderBy(asc(memories.createdAt))
        .limit(BATCH)
      if (live.length < CONSOLIDATE_ABOVE) return null

      const raw = live
        .map((note, index) => `[${index + 1}] ${note.title}\n${note.body.trim().slice(0, 1200)}`)
        .join('\n\n')
      const { text } = await generateText({ model, messages: [{ role: 'user', content: `${PROMPT}\n\n${raw}` }] })

      // A model that answers with prose instead of JSON must not cost the
      // agent its logbook: nothing is expired unless something was understood.
      let kept: { title: string; body: string; kind: string }[]
      try {
        const match = text.match(/\{[\s\S]*\}/)
        const parsed = JSON.parse(match ? match[0] : text) as { notes?: unknown }
        kept = Array.isArray(parsed.notes) ? (parsed.notes as typeof kept) : []
      } catch {
        return null
      }

      const written: string[] = []
      for (const note of kept.slice(0, 5)) {
        if (typeof note?.title !== 'string' || typeof note?.body !== 'string') continue
        written.push(
          await createNote({
            tenantId,
            scope: 'agent',
            personId: agent.id,
            kind: note.kind === 'procedure' || note.kind === 'reflection' ? note.kind : 'fact',
            title: note.title.slice(0, 200),
            body: note.body,
            author: 'consolidator',
            importance: 3,
          }),
        )
      }

      // Expired, not deleted, and pointed at what replaced them — so the day
      // is still readable in full by anyone who goes looking, and invisible to
      // everything that reads memory in order to work.
      await app.db
        .update(memories)
        .set({
          validUntil: new Date(),
          pinned: false,
          ...(written[0] ? { supersededBy: written[0] } : {}),
          updatedAt: new Date(),
        })
        .where(
          sql`${memories.id} = any(${sql.raw(`ARRAY[${live.map((n) => `'${n.id}'::uuid`).join(',')}]`)})`,
        )

      return { agent: agent.name, read: live.length, kept: written.length }
    })
    if (consolidated) done.push(consolidated)
  }
  return done
}
