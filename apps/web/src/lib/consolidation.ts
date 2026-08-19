import 'server-only'
import { and, asc, desc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { generateText } from 'ai'
import { getModel } from '@braedonsaunders/appkit-ai'
import { memories, memoryProposals, people, runEvents, runs } from '../db/schema'
import { db } from '../db/client'
import { resolveAgentAiConfig } from './ai'
import { createNote, expireNote, parseWikilinks, slugify } from './memory'

/**
 * The Logbook consolidation jobs:
 * sleep-time compute whose every output is a readable note or a reviewable
 * proposal. The nightly journal turns yesterday's run events into episode
 * notes and fact candidates; the weekly reflection distils recent episodes
 * into evidence-cited conclusions and files procedure changes as PROPOSALS —
 * the consolidator never rewrites a procedure directly. Both passes are
 * idempotent so overlapping worker ticks are safe.
 */

const MAX_RUNS_PER_JOURNAL = 20
const MAX_EVENTS_PER_RUN = 30
const MAX_EVENT_CHARS = 400
const MAX_SLUG_HINTS = 200

/** The gardener runs at most once per tenant in this many days. */
const GARDENER_PERIOD_DAYS = 30
/** Bound on how many live company notes ever reach the model in one pass —
 *  the priority score below picks the ones most worth reviewing. */
const MAX_NOTES_PER_GARDENER_PASS = 60
/** Per-note body truncation inside the gardener prompt. */
const MAX_GARDENER_NOTE_CHARS = 700

type Agent = typeof people.$inferSelect

/** Active agents in the tenant; the AI config check happens per agent later. */
async function activeAgents(tenantId: string): Promise<Agent[]> {
  const app = db()
  return app.withTenantContext(tenantId, () =>
    app.db
      .select()
      .from(people)
      .where(and(eq(people.kind, 'agent'), eq(people.status, 'active'))),
  )
}

/** Yesterday 00:00 UTC — the journal window's left edge. */
function journalWindowStart(): Date {
  const start = new Date()
  start.setUTCHours(0, 0, 0, 0)
  start.setUTCDate(start.getUTCDate() - 1)
  return start
}

/** Models are asked for bare JSON but fenced/prefixed replies still parse. */
function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('No JSON object in model output.')
  return JSON.parse(cleaned.slice(start, end + 1))
}

const importanceSchema = z.coerce.number().int().min(1).max(5).catch(3)

const journalSchema = z.object({
  episodes: z
    .array(
      z.object({
        runId: z.string(),
        title: z.string().min(1).max(200),
        body: z.string().min(1),
        importance: importanceSchema.default(3),
      }),
    )
    .default([]),
  facts: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        body: z.string().min(1),
        importance: importanceSchema.default(3),
        rationale: z.string().default(''),
      }),
    )
    .default([]),
})

const reflectionSchema = z.object({
  reflections: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        body: z.string().min(1),
        importance: importanceSchema.default(3),
      }),
    )
    .default([]),
  procedureProposals: z
    .array(
      z.object({
        slug: z.string().min(1),
        title: z.string().min(1).max(200),
        body: z.string().min(1),
        rationale: z.string().min(1),
      }),
    )
    .default([]),
})

const gardenerSchema = z.object({
  merges: z
    .array(
      z.object({
        noteIds: z.array(z.string()).min(2),
        title: z.string().min(1).max(200),
        body: z.string().min(1),
        rationale: z.string().min(1),
      }),
    )
    .default([]),
  expirations: z
    .array(
      z.object({
        noteId: z.string().min(1),
        rationale: z.string().min(1),
      }),
    )
    .default([]),
  contradictions: z
    .array(
      z.object({
        noteIds: z.array(z.string()).length(2),
        title: z.string().min(1).max(200),
        body: z.string().min(1),
        rationale: z.string().min(1),
      }),
    )
    .default([]),
})

/** Live note slugs the model may [[wikilink]] to (agent + company scope). */
async function linkableSlugs(tenantId: string, personId: string): Promise<{ slug: string; kind: string; title: string }[]> {
  const app = db()
  const rows = await app.db
    .select({ slug: memories.slug, kind: memories.kind, title: memories.title })
    .from(memories)
    .where(
      and(
        isNull(memories.validUntil),
        eq(memories.status, 'active'),
        sql`(${memories.scope} = 'company' or ${memories.personId} = ${personId})`,
      ),
    )
    .limit(MAX_SLUG_HINTS)
  return rows
}

/** An open proposal already targeting this note — don't file a duplicate. */
async function hasOpenProposal(noteId: string, kind: 'merge' | 'supersede' | 'edit' | 'expire'): Promise<boolean> {
  const app = db()
  const [row] = await app.db
    .select({ id: memoryProposals.id })
    .from(memoryProposals)
    .where(and(eq(memoryProposals.noteId, noteId), eq(memoryProposals.kind, kind), eq(memoryProposals.status, 'open')))
    .limit(1)
  return Boolean(row)
}

/**
 * Nightly journal for every agent with a model: yesterday's completed runs +
 * their events become episode notes (written directly, one per meaningful
 * run) and up to three fact candidates (written directly, or filed as a
 * supersede PROPOSAL when a live same-slug note already exists).
 *
 * Idempotent per run: a run is skipped once any episode note carries its id
 * as sourceRunId, so overlapping 6-hour ticks never journal a run twice.
 */
export async function journalPass(tenantId: string): Promise<void> {
  const app = db()
  for (const agent of await activeAgents(tenantId)) {
    try {
      const ai = await resolveAgentAiConfig(tenantId, agent.id)
      if (!ai) continue
      const model = getModel(ai, 'smart')
      if (!model) continue

      await app.withTenant(tenantId, async () => {
        const completed = await app.db
          .select()
          .from(runs)
          .where(
            and(
              eq(runs.personId, agent.id),
              eq(runs.status, 'completed'),
              gte(runs.finishedAt, journalWindowStart()),
            ),
          )
          .orderBy(asc(runs.finishedAt))
          .limit(MAX_RUNS_PER_JOURNAL)
        if (completed.length === 0) return

        // Idempotency: an episode note with sourceRunId = run.id means that
        // run is already in the logbook.
        const journaled = await app.db
          .select({ sourceRunId: memories.sourceRunId })
          .from(memories)
          .where(
            and(
              inArray(memories.sourceRunId, completed.map((r) => r.id)),
              eq(memories.kind, 'episode'),
            ),
          )
        const done = new Set(journaled.map((m) => m.sourceRunId))
        const fresh = completed.filter((r) => !done.has(r.id))
        if (fresh.length === 0) return

        // The journal is what the agent did, so the trace is left out of it:
        // those rows are the operational record of why it spoke and what became
        // of each piece of work, and there are enough of them per call to spend
        // the whole per-run event budget below on instrumentation instead of on
        // the work the note is supposed to be about.
        const events = await app.db
          .select()
          .from(runEvents)
          .where(and(inArray(runEvents.runId, fresh.map((r) => r.id)), ne(runEvents.kind, 'trace')))
          .orderBy(asc(runEvents.seq))
        const eventsByRun = new Map<string, string[]>()
        for (const event of events) {
          const list = eventsByRun.get(event.runId) ?? []
          if (list.length < MAX_EVENTS_PER_RUN) {
            list.push(`${event.kind}: ${JSON.stringify(event.payload).slice(0, MAX_EVENT_CHARS)}`)
          }
          eventsByRun.set(event.runId, list)
        }

        const slugs = await linkableSlugs(tenantId, agent.id)
        const runsBlock = fresh
          .map(
            (run) =>
              `runId: ${run.id}\ntrigger: ${run.trigger.type}\nsummary: ${run.summary ?? '(none)'}\nevents:\n${(eventsByRun.get(run.id) ?? []).map((e) => `  - ${e}`).join('\n') || '  (no events)'}`,
          )
          .join('\n\n')

        const { text } = await generateText({
          model,
          system:
            `You are the memory consolidator writing the nightly journal for ${agent.name} (${agent.title}). ` +
            'You turn yesterday\'s work into logbook notes in markdown. Respond with ONLY a JSON object, no prose.',
          prompt:
            `Yesterday's completed runs for this agent:\n\n${runsBlock}\n\n` +
            `Existing live note slugs you may reference with [[slug]] wikilinks (use one ONLY when that exact note is clearly relevant):\n` +
            `${slugs.map((s) => `- [[${s.slug}]] (${s.kind}): ${s.title}`).join('\n') || '(none yet)'}\n\n` +
            'Write:\n' +
            '1. "episodes": one entry per MEANINGFUL run (skip trivial ones — declined mail, empty runs, pure no-ops). ' +
            'Each has "runId" (copied exactly from above), "title" (short, specific), "body" (2-4 sentences of markdown ' +
            'describing what happened and the outcome, with [[slug]] wikilinks where an existing note is clearly referenced) ' +
            'and "importance" (1-5, how much this episode will matter later).\n' +
            '2. "facts": up to 3 candidate fact notes — durable, currently-true statements learned from these runs ' +
            '(a contact\'s preference, a system detail, a standing constraint). Each has "title", "body" (markdown), ' +
            '"importance" (1-5) and "rationale" (why this is worth remembering). No speculation; omit facts you are unsure of.\n\n' +
            'Return JSON: {"episodes": [...], "facts": [...]}',
        })

        const parsed = journalSchema.parse(extractJson(text))
        const freshIds = new Set(fresh.map((r) => r.id))
        for (const episode of parsed.episodes) {
          if (!freshIds.has(episode.runId)) continue
          try {
            await createNote({
              tenantId,
              scope: 'agent',
              personId: agent.id,
              kind: 'episode',
              title: episode.title,
              body: episode.body,
              author: 'consolidator',
              importance: episode.importance,
              sourceRunId: episode.runId,
            })
          } catch (error) {
            console.error(`[journal] ${agent.name} episode "${episode.title}":`, (error as Error).message)
          }
        }

        for (const fact of parsed.facts.slice(0, 3)) {
          try {
            const slug = slugify(fact.title)
            const [existing] = await app.db
              .select()
              .from(memories)
              .where(
                and(
                  eq(memories.scope, 'agent'),
                  eq(memories.personId, agent.id),
                  eq(memories.slug, slug),
                  isNull(memories.validUntil),
                ),
              )
            if (existing) {
              // Never overwrite a live note from a background job — file a
              // supersede proposal and let a human decide.
              if (await hasOpenProposal(existing.id, 'supersede')) continue
              await app.db.insert(memoryProposals).values({
                tenantId,
                kind: 'supersede',
                noteId: existing.id,
                payload: { title: fact.title, body: fact.body, noteIds: [existing.id] },
                rationale: fact.rationale || `Nightly journal found a newer version of [[${existing.slug}]].`,
                proposedByPersonId: null,
              })
            } else {
              await createNote({
                tenantId,
                scope: 'agent',
                personId: agent.id,
                kind: 'fact',
                title: fact.title,
                body: fact.body,
                author: 'consolidator',
                importance: fact.importance,
              })
            }
          } catch (error) {
            console.error(`[journal] ${agent.name} fact "${fact.title}":`, (error as Error).message)
          }
        }
        console.log(`[journal] ${agent.name}: ${parsed.episodes.length} episode(s), ${parsed.facts.length} fact candidate(s) from ${fresh.length} run(s)`)
      })
    } catch (error) {
      console.error(`[journal] ${agent.name}:`, (error as Error).message)
    }
  }
}

/**
 * Weekly reflection per agent: at least three episode notes from the last
 * seven days are distilled into 1-2 reflection notes — each MUST cite at
 * least two evidence episodes via [[slug]] wikilinks or it is dropped — and
 * 0-2 procedure-change PROPOSALS (memory_proposals kind 'edit'); the
 * consolidator never edits a procedure note directly.
 *
 * Idempotent per agent: skipped while a consolidator-authored reflection from
 * the last six days exists, so 12-hour ticks yield at most one reflection a week.
 */
export async function reflectionPass(tenantId: string): Promise<void> {
  const app = db()
  for (const agent of await activeAgents(tenantId)) {
    try {
      const ai = await resolveAgentAiConfig(tenantId, agent.id)
      if (!ai) continue
      const model = getModel(ai, 'smart')
      if (!model) continue

      await app.withTenant(tenantId, async () => {
        const sixDaysAgo = new Date(Date.now() - 6 * 86400_000)
        const [recent] = await app.db
          .select({ id: memories.id })
          .from(memories)
          .where(
            and(
              eq(memories.personId, agent.id),
              eq(memories.kind, 'reflection'),
              eq(memories.author, 'consolidator'),
              gte(memories.createdAt, sixDaysAgo),
            ),
          )
          .limit(1)
        if (recent) return

        const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000)
        const episodes = await app.db
          .select()
          .from(memories)
          .where(
            and(
              eq(memories.scope, 'agent'),
              eq(memories.personId, agent.id),
              eq(memories.kind, 'episode'),
              isNull(memories.validUntil),
              eq(memories.status, 'active'),
              gte(memories.createdAt, sevenDaysAgo),
            ),
          )
          .orderBy(asc(memories.createdAt))
        if (episodes.length < 3) return

        const procedureNotes = await app.db
          .select()
          .from(memories)
          .where(
            and(
              eq(memories.scope, 'agent'),
              eq(memories.personId, agent.id),
              eq(memories.kind, 'procedure'),
              isNull(memories.validUntil),
              eq(memories.status, 'active'),
            ),
          )

        const { text } = await generateText({
          model,
          system:
            `You are the memory consolidator writing the weekly reflection for ${agent.name} (${agent.title}). ` +
            'You look for patterns across the week\'s episodes. Respond with ONLY a JSON object, no prose.',
          prompt:
            `This week's episode notes for this agent:\n\n` +
            `${episodes.map((e) => `[[${e.slug}]] "${e.title}" (importance ${e.importance}):\n${e.body}`).join('\n\n')}\n\n` +
            `This agent's live procedure notes:\n` +
            `${procedureNotes.map((p) => `[[${p.slug}]] "${p.title}":\n${p.body}`).join('\n\n') || '(none)'}\n\n` +
            'Write:\n' +
            '1. "reflections": 1-2 conclusions drawn from the week (a pattern, a recurring blocker, something that ' +
            'consistently works). Each has "title", "body" (markdown that MUST cite at least two of the episode notes ' +
            'above as [[slug]] wikilinks — a reflection without evidence is invalid) and "importance" (1-5).\n' +
            '2. "procedureProposals": 0-2 proposed changes to the procedure notes above, ONLY where the week\'s evidence ' +
            'shows the current text is wrong or incomplete. Each has "slug" (the procedure note\'s slug, copied exactly), ' +
            '"title" and "body" (the full revised note) and "rationale" (which episodes motivated the change and why). ' +
            'If there are no procedure notes, or no change is warranted, return an empty array.\n\n' +
            'Return JSON: {"reflections": [...], "procedureProposals": [...]}',
        })

        const parsed = reflectionSchema.parse(extractJson(text))
        const evidenceSlugs = new Set(episodes.map((e) => e.slug))
        let written = 0
        for (const reflection of parsed.reflections.slice(0, 2)) {
          const cited = parseWikilinks(reflection.body).filter((slug) => evidenceSlugs.has(slug))
          if (cited.length < 2) {
            console.error(`[reflection] ${agent.name}: dropped "${reflection.title}" — cites ${cited.length} evidence episode(s), needs 2`)
            continue
          }
          try {
            await createNote({
              tenantId,
              scope: 'agent',
              personId: agent.id,
              kind: 'reflection',
              title: reflection.title,
              body: reflection.body,
              author: 'consolidator',
              importance: reflection.importance,
            })
            written += 1
          } catch (error) {
            console.error(`[reflection] ${agent.name} "${reflection.title}":`, (error as Error).message)
          }
        }

        let proposed = 0
        for (const change of parsed.procedureProposals.slice(0, 2)) {
          const target = procedureNotes.find((p) => p.slug === change.slug)
          if (!target) continue
          if (await hasOpenProposal(target.id, 'edit')) continue
          await app.db.insert(memoryProposals).values({
            tenantId,
            kind: 'edit',
            noteId: target.id,
            payload: { title: change.title, body: change.body },
            rationale: change.rationale,
            proposedByPersonId: null,
          })
          proposed += 1
        }
        console.log(`[reflection] ${agent.name}: ${written} reflection(s), ${proposed} procedure proposal(s) from ${episodes.length} episode(s)`)
      })
    } catch (error) {
      console.error(`[reflection] ${agent.name}:`, (error as Error).message)
    }
  }
}

type GardenerNote = typeof memories.$inferSelect

/** A silent bookkeeping row: no note, no diff, never rendered — it only
 *  exists so the idempotency check below finds a "this period is used"
 *  marker even on a cycle where nothing was worth proposing. Every real
 *  finding (an auto-applied merge, or an open merge/expire/edit) already
 *  carries payload.origin = 'gardener' too, so it gates the next 30 days
 *  on its own; this is only inserted when nothing else was written. */
function gardenerMarker(rationale: string) {
  return {
    kind: 'expire' as const,
    noteId: null,
    payload: { origin: 'gardener' as const, noteIds: [] as string[] },
    rationale,
    proposedByPersonId: null,
    status: 'auto_applied' as const,
    decidedBy: 'consolidator',
    decidedAt: new Date(),
  }
}

/**
 * Monthly company gardener: a
 * housekeeping pass over live COMPANY notes only — merge near-duplicates,
 * expire notes that are stale or superseded in substance, and flag pairs
 * that contradict each other. Every finding is a memory_proposals row; the
 * gardener never edits or deletes a note itself. The one exception is the
 * provably-safe class doctrine calls out explicitly: an exact-duplicate
 * body under a different slug is closed immediately (via the same
 * expireNote every human approval uses) and recorded as 'auto_applied'.
 *
 * Idempotent per tenant: skipped while a gardener-authored proposal
 * (payload.origin = 'gardener', any status) exists from the last ~30 days,
 * so overlapping ticks yield at most one gardener pass a month.
 */
export async function gardenerPass(tenantId: string): Promise<{ proposed: number }> {
  const app = db()

  // Read-only gate, checked before opening a transaction or touching any
  // provider key: a gardener-authored proposal (any status) from the last
  // ~30 days means this tenant's period is already used.
  const [lastRun] = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ createdAt: memoryProposals.createdAt })
      .from(memoryProposals)
      .where(sql`${memoryProposals.payload} ->> 'origin' = 'gardener'`)
      .orderBy(desc(memoryProposals.createdAt))
      .limit(1),
  )
  if (lastRun && lastRun.createdAt.getTime() > Date.now() - GARDENER_PERIOD_DAYS * 86400_000) {
    return { proposed: 0 }
  }

  // Resolved before the transaction opens, same as journalPass/reflectionPass —
  // config lookup and secret unsealing shouldn't happen mid-transaction.
  let model: ReturnType<typeof getModel> = null
  for (const agent of await activeAgents(tenantId)) {
    const ai = await resolveAgentAiConfig(tenantId, agent.id)
    if (!ai) continue
    model = getModel(ai, 'smart')
    if (model) break
  }

  return app.withTenant(tenantId, async () => {
    // Priority: staler notes (long unread) and higher-importance notes both
    // deserve a look; a note can earn a place in the bounded set either way.
    const priority = sql<number>`(
        extract(epoch from (now() - coalesce(${memories.lastUsedAt}, ${memories.createdAt}))) / 86400.0
      + (${memories.importance}::float * 20.0)
      )`.mapWith(Number)
    let notes: GardenerNote[] = await app.db
      .select()
      .from(memories)
      .where(and(eq(memories.scope, 'company'), isNull(memories.validUntil), eq(memories.status, 'active')))
      .orderBy(desc(priority))
      .limit(MAX_NOTES_PER_GARDENER_PASS)

    let proposed = 0

    // Deterministic, LLM-free auto-apply: bodies that are byte-identical
    // (after trimming) under different slugs carry no information loss, so
    // this is the one class the doctrine allows to skip human review. A
    // pinned note in the group means a human curated it deliberately —
    // leave the whole group for the model/human path instead.
    const groups = new Map<string, GardenerNote[]>()
    for (const note of notes) {
      const key = note.body.trim()
      const list = groups.get(key) ?? []
      list.push(note)
      groups.set(key, list)
    }
    const closedIds = new Set<string>()
    for (const group of groups.values()) {
      if (group.length < 2 || group.some((note) => note.pinned)) continue
      const [survivor, ...duplicates] = [...group].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      if (!survivor || duplicates.length === 0) continue
      for (const duplicate of duplicates) {
        await expireNote(tenantId, duplicate.id)
        closedIds.add(duplicate.id)
      }
      const dupSlugs = duplicates.map((d) => `[[${d.slug}]]`).join(', ')
      await app.db.insert(memoryProposals).values({
        tenantId,
        kind: 'merge',
        noteId: survivor.id,
        payload: {
          title: survivor.title,
          body: survivor.body,
          noteIds: [survivor.id, ...duplicates.map((d) => d.id)],
          origin: 'gardener',
        },
        rationale: `${dupSlugs} ${duplicates.length > 1 ? 'were' : 'was'} word-for-word identical to [[${survivor.slug}]] — retired as an exact duplicate, no wording lost.`,
        proposedByPersonId: null,
        status: 'auto_applied',
        decidedBy: 'consolidator',
        decidedAt: new Date(),
      })
      proposed += 1
    }
    notes = notes.filter((note) => !closedIds.has(note.id))

    if (notes.length === 0) {
      if (proposed === 0) {
        await app.db.insert(memoryProposals).values({
          tenantId,
          ...gardenerMarker('Monthly housekeeping scan: no company notes to review yet.'),
        })
      }
      console.log(`[gardener] tenant ${tenantId}: ${proposed} auto-applied merge(s), nothing left to reason over`)
      return { proposed }
    }

    if (!model) {
      // No usable provider yet — leave the period open so gardening starts
      // the moment one is configured, rather than waiting out the month.
      console.log(`[gardener] tenant ${tenantId}: ${proposed} auto-applied merge(s), no configured model to reason further`)
      return { proposed }
    }

    const byId = new Map(notes.map((note) => [note.id, note]))
    const notesBlock = notes
      .map(
        (note) =>
          `id: ${note.id}\nslug: [[${note.slug}]]\nkind: ${note.kind}\nimportance: ${note.importance}\n` +
          `last touched: ${(note.lastUsedAt ?? note.createdAt).toISOString().slice(0, 10)}\n` +
          `title: ${note.title}\nbody: ${note.body.slice(0, MAX_GARDENER_NOTE_CHARS)}`,
      )
      .join('\n\n')

    let text: string
    try {
      ;({ text } = await generateText({
        model,
        system:
          'You are the memory consolidator running the monthly housekeeping pass over this company\'s shared ' +
          'knowledge notes. You look for near-duplicates to merge, notes that are stale or no longer true to ' +
          'retire, and pairs of notes that state something contradictory. Respond with ONLY a JSON object, no prose.',
        prompt:
          `Live company notes (id is what you must reference — copy it exactly):\n\n${notesBlock}\n\n` +
          'Return JSON with three arrays. Every "noteIds"/"noteId" value MUST be copied exactly from an "id" above; ' +
          'invent nothing, and when in doubt leave a note out.\n' +
          '1. "merges": near-duplicate notes that say the same thing in different words (NOT byte-identical — those ' +
          'are already handled). Each has "noteIds" (2+, the notes to fold together), "title" and "body" (the single ' +
          'merged note, markdown, keeping every distinct fact from all of them) and "rationale".\n' +
          '2. "expirations": notes that are stale (no longer relevant) or superseded in substance by something ' +
          'else you can see here, but NOT a near-duplicate (that belongs in "merges"). Each has "noteId" and ' +
          '"rationale" explaining why it no longer holds.\n' +
          '3. "contradictions": pairs of LIVE notes that assert incompatible things. Each has "noteIds" (exactly 2), ' +
          '"title" and "body" (the corrected note that resolves the conflict, citing both with [[slug]]) and ' +
          '"rationale" explaining the contradiction.\n' +
          'Leave any array empty if nothing qualifies — do not force findings.\n\n' +
          'Return JSON: {"merges": [...], "expirations": [...], "contradictions": [...]}',
      }))
    } catch (error) {
      console.error(`[gardener] tenant ${tenantId}: model call failed:`, (error as Error).message)
      return { proposed }
    }

    let parsed: z.infer<typeof gardenerSchema>
    try {
      parsed = gardenerSchema.parse(extractJson(text))
    } catch (error) {
      console.error(`[gardener] tenant ${tenantId}: malformed model output, recording nothing:`, (error as Error).message)
      await app.db.insert(memoryProposals).values({
        tenantId,
        ...gardenerMarker('Monthly housekeeping pass ran, but the model\'s output could not be parsed — no suggestions were recorded this cycle.'),
      })
      return { proposed }
    }

    // A note may not be claimed by more than one finding in the same pass —
    // keeps the proposals a human sees non-overlapping and easy to reason about.
    const claimed = new Set<string>()
    const validIds = (ids: string[]) => ids.every((noteId) => byId.has(noteId) && !claimed.has(noteId))

    for (const merge of parsed.merges) {
      const ids = [...new Set(merge.noteIds)]
      if (ids.length < 2 || !validIds(ids)) continue
      const survivorId = ids[0]!
      if (await hasOpenProposal(survivorId, 'merge')) continue
      await app.db.insert(memoryProposals).values({
        tenantId,
        kind: 'merge',
        noteId: survivorId,
        payload: { title: merge.title, body: merge.body, noteIds: ids, origin: 'gardener' },
        rationale: merge.rationale,
        proposedByPersonId: null,
      })
      ids.forEach((id) => claimed.add(id))
      proposed += 1
    }

    for (const expiration of parsed.expirations) {
      if (!validIds([expiration.noteId])) continue
      if (byId.get(expiration.noteId)!.pinned) continue
      if (await hasOpenProposal(expiration.noteId, 'expire')) continue
      const note = byId.get(expiration.noteId)!
      await app.db.insert(memoryProposals).values({
        tenantId,
        kind: 'expire',
        noteId: expiration.noteId,
        payload: { title: note.title, body: note.body, noteIds: [expiration.noteId], origin: 'gardener' },
        rationale: expiration.rationale,
        proposedByPersonId: null,
      })
      claimed.add(expiration.noteId)
      proposed += 1
    }

    for (const contradiction of parsed.contradictions) {
      const ids = [...new Set(contradiction.noteIds)]
      if (ids.length !== 2 || !validIds(ids)) continue
      const targetId = ids[0]!
      if (await hasOpenProposal(targetId, 'edit')) continue
      await app.db.insert(memoryProposals).values({
        tenantId,
        kind: 'edit',
        noteId: targetId,
        payload: { title: contradiction.title, body: contradiction.body, noteIds: ids, origin: 'gardener' },
        rationale: contradiction.rationale,
        proposedByPersonId: null,
      })
      ids.forEach((id) => claimed.add(id))
      proposed += 1
    }

    if (proposed === 0) {
      await app.db.insert(memoryProposals).values({
        tenantId,
        ...gardenerMarker('Monthly housekeeping scan found no duplicate, stale, or contradictory company notes.'),
      })
    }
    console.log(`[gardener] tenant ${tenantId}: ${proposed} proposal(s) from ${notes.length} live company note(s)`)
    return { proposed }
  })
}
