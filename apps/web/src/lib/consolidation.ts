import 'server-only'
import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { generateText } from 'ai'
import { getModel } from '@appkit/ai'
import { memories, memoryProposals, people, runEvents, runs } from '../db/schema'
import { db } from '../db/client'
import { resolveAgentAiConfig } from './ai'
import { createNote, parseWikilinks, slugify } from './memory'

/**
 * The Logbook consolidation jobs (docs/memory-design.md §"Consolidation jobs"):
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
async function hasOpenProposal(noteId: string, kind: 'supersede' | 'edit'): Promise<boolean> {
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

        const events = await app.db
          .select()
          .from(runEvents)
          .where(inArray(runEvents.runId, fresh.map((r) => r.id)))
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
