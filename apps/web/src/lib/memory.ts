import 'server-only'
import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import { memories, memoryLinks, memoryProposals, memoryRevisions } from '../db/schema'
import { db } from '../db/client'
import type { ResourceAssignment } from '../db/schema'
import type { AgentBinding } from './assignment'
import { embedText, embeddableText, toVectorLiteral } from './embeddings'
import { anyTermQuery, normalizeFused, reciprocalRankFusion } from './memory-query'

/**
 * The Logbook engine (docs/memory-design.md). Markdown notes are the source of
 * truth; wikilinks are the graph; supersession is append-only; retrieval is
 * importance × recency × relevance over tsvector. Callers run inside a tenant
 * context (withTenant/withTenantContext).
 */

export type NoteKind = 'fact' | 'episode' | 'procedure' | 'reflection'

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'note'
}

export function parseWikilinks(body: string): string[] {
  return [...body.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g)]
    .map((m) => slugify(m[1]!.trim()))
    .filter((v, i, a) => v && a.indexOf(v) === i)
}

/** Re-derive the link cache for one note from its body. */
async function syncLinks(tenantId: string, noteId: string, personId: string | null, body: string): Promise<void> {
  const app = db()
  const slugs = parseWikilinks(body)
  await app.db.delete(memoryLinks).where(eq(memoryLinks.fromNote, noteId))
  if (slugs.length === 0) return
  const targets = await app.db
    .select({ id: memories.id })
    .from(memories)
    .where(
      and(
        inArray(memories.slug, slugs),
        isNull(memories.validUntil),
        sql`(${memories.scope} = 'company' or ${memories.personId} ${personId ? sql`= ${personId}` : sql`is null`})`,
      ),
    )
  if (targets.length === 0) return
  await app.db
    .insert(memoryLinks)
    .values(targets.map((t) => ({ tenantId, fromNote: noteId, toNote: t.id })))
    .onConflictDoNothing()
}

/**
 * Whether this database can answer a semantic question yet.
 *
 * pgvector needs a superuser to install and the migration role is not one, so a
 * deployment can legitimately be running the lexical legs alone. Asking the
 * catalogue once and remembering the answer is what lets the same code serve
 * both states — the alternative is a query that references a column that is not
 * there, which does not degrade, it throws, and takes the agent's whole memory
 * with it.
 */
let semanticRecall: boolean | null = null
async function semanticRecallAvailable(): Promise<boolean> {
  if (semanticRecall !== null) return semanticRecall
  try {
    const app = db()
    const result = await app.db.execute(
      sql`select 1 from information_schema.columns where table_name = 'memories' and column_name = 'embedding' limit 1`,
    )
    const rows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[])
    semanticRecall = Array.isArray(rows) && rows.length > 0
  } catch {
    semanticRecall = false
  }
  if (!semanticRecall) {
    console.warn('[memory] semantic recall is off — pgvector is not installed, so retrieval runs on its lexical legs')
  }
  return semanticRecall
}

/**
 * Store a note's embedding, beside the note rather than inside its write.
 *
 * Fire-and-forget on purpose: embedding is a network call to a third party, and
 * an agent that cannot save what it just learned because someone else's API is
 * slow is a far worse failure than a note that is briefly missing from semantic
 * recall. A note with no vector is still found by both lexical legs, and the
 * backfill script sweeps up anything that was missed.
 */
function rememberEmbedding(tenantId: string, noteId: string, title: string, body: string): void {
  void (async () => {
    try {
      if (!(await semanticRecallAvailable())) return
      const vector = await embedText(tenantId, embeddableText(title, body))
      if (!vector) return
      const app = db()
      await app.db.execute(
        sql`update memories set embedding = ${toVectorLiteral(vector)}::vector where id = ${noteId}`,
      )
    } catch (error) {
      console.error(`[memory] could not embed note ${noteId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()
}

export type CreateNoteInput = {
  tenantId: string
  scope: 'agent' | 'company'
  personId: string | null
  kind: NoteKind
  title: string
  body: string
  author: 'agent' | 'human' | 'consolidator'
  importance?: number
  pinned?: boolean
  sourceRunId?: string
  /**
   * Which agents company knowledge reaches. Company knowledge is the whole
   * company's by default — narrowing it to a role is a deliberate act on the
   * note. Ignored on agent scope, where the note belongs to one agent.
   */
  assignment?: ResourceAssignment
}

export async function createNote(input: CreateNoteInput): Promise<string> {
  const app = db()
  const base = slugify(input.title)
  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`
    const [row] = await app.db
      .insert(memories)
      .values({
        tenantId: input.tenantId,
        scope: input.scope,
        personId: input.personId,
        slug,
        kind: input.kind,
        title: input.title,
        body: input.body,
        author: input.author,
        importance: Math.min(5, Math.max(1, input.importance ?? 3)),
        pinned: input.pinned ?? false,
        sourceRunId: input.sourceRunId ?? null,
        assignment: input.scope === 'company' ? (input.assignment ?? { everyone: true }) : {},
      })
      .onConflictDoNothing()
      .returning({ id: memories.id })
    if (row) {
      await syncLinks(input.tenantId, row.id, input.personId, input.body)
      rememberEmbedding(input.tenantId, row.id, input.title, input.body)
      return row.id
    }
  }
  throw new Error(`A live note with slug "${base}" already exists here.`)
}

/** In-place correction: snapshot the prior head, then update. */
export async function correctNote(args: {
  tenantId: string
  noteId: string
  title: string
  body: string
  editedBy: string
  reason?: string
  importance?: number
}): Promise<void> {
  const app = db()
  const [head] = await app.db.select().from(memories).where(eq(memories.id, args.noteId))
  if (!head) throw new Error('Note not found.')
  const [last] = await app.db
    .select({ rev: memoryRevisions.rev })
    .from(memoryRevisions)
    .where(eq(memoryRevisions.noteId, args.noteId))
    .orderBy(desc(memoryRevisions.rev))
    .limit(1)
  await app.db.insert(memoryRevisions).values({
    tenantId: args.tenantId,
    noteId: args.noteId,
    rev: (last?.rev ?? 0) + 1,
    title: head.title,
    body: head.body,
    editedBy: args.editedBy,
    reason: args.reason ?? 'correction',
  })
  await app.db
    .update(memories)
    .set({
      title: args.title,
      body: args.body,
      ...(args.importance ? { importance: Math.min(5, Math.max(1, args.importance)) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(memories.id, args.noteId))
  await syncLinks(args.tenantId, args.noteId, head.personId, args.body)
  // The words changed, so the vector is now about the old ones.
  rememberEmbedding(args.tenantId, args.noteId, args.title, args.body)
}

/** Contradiction: new note supersedes the old; the old is closed, not deleted. */
export async function supersedeNote(args: {
  tenantId: string
  oldNoteId: string
  title: string
  body: string
  author: 'agent' | 'human' | 'consolidator'
  sourceRunId?: string
}): Promise<string> {
  const app = db()
  const [old] = await app.db.select().from(memories).where(eq(memories.id, args.oldNoteId))
  if (!old) throw new Error('Note not found.')
  if (old.validUntil) throw new Error('Note is already superseded.')
  const newId = await createNote({
    tenantId: args.tenantId,
    scope: old.scope,
    personId: old.personId,
    kind: old.kind,
    title: args.title,
    body: args.body,
    author: args.author,
    importance: old.importance,
    pinned: old.pinned,
    ...(args.sourceRunId ? { sourceRunId: args.sourceRunId } : {}),
  })
  await app.db
    .update(memories)
    .set({ validUntil: new Date(), supersededBy: newId, pinned: false, updatedAt: new Date() })
    .where(eq(memories.id, args.oldNoteId))
  return newId
}

/** Expire without successor (stale episode, wrong note). Never a DELETE. */
export async function expireNote(tenantId: string, noteId: string): Promise<void> {
  const app = db()
  await app.db
    .update(memories)
    .set({ validUntil: new Date(), pinned: false, updatedAt: new Date() })
    .where(and(eq(memories.id, noteId), isNull(memories.validUntil)))
}

/** Recency half-lives per kind, in days. Procedures effectively never decay. */
const HALF_LIFE_DAYS: Record<NoteKind, number> = { episode: 14, fact: 180, reflection: 90, procedure: 3650 }

/**
 * The notes one agent may read: its own logbook, plus the company knowledge
 * assigned to it. Company scope no longer implies everybody — a note can be
 * given to the agents holding a role, so what an agent knows is governed by the
 * same assignment that governs the procedures it follows.
 */
function reachableBy(agent: AgentBinding) {
  const asJson = (value: string) => sql`${JSON.stringify([value])}::jsonb`
  const byRole = agent.roleSlug
    ? sql` or ${memories.assignment} -> 'roles' @> ${asJson(agent.roleSlug)}`
    : sql``
  return sql`((${memories.scope} = 'agent' and ${memories.personId} = ${agent.personId})
    or (${memories.scope} = 'company' and (
          ${memories.assignment} -> 'everyone' = 'true'::jsonb
       or ${memories.assignment} -> 'personIds' @> ${asJson(agent.personId)}${byRole})))`
}

export type RetrievedNote = typeof memories.$inferSelect & { score: number }

/**
 * The composite retrieval: relevance (FTS) + importance + recency + proven
 * usefulness, live notes only, then one hop of wikilink expansion. Marks
 * usage — notes earn their keep.
 */
export async function retrieveNotes(args: {
  tenantId: string
  agent: AgentBinding
  query: string
  limit?: number
}): Promise<RetrievedNote[]> {
  const app = db()
  const limit = args.limit ?? 8
  const query = args.query.slice(0, 500)

  // --- Relevance: three legs, fused ----------------------------------------
  // Strict lexical (every word present), loose lexical (any word), and
  // semantic. Fusing them is what stops one absent synonym from zeroing the
  // whole match — the defect that used to leave retrieval silently returning
  // whatever was recent and important. See memory-query.ts for the receipts.
  const anyTerms = anyTermQuery(query)
  const queryVector = (await semanticRecallAvailable())
    ? await embedText(args.tenantId, query).catch(() => null)
    : null

  const candidateWhere = and(
    isNull(memories.validUntil),
    eq(memories.status, 'active'),
    eq(memories.pinned, false),
    reachableBy(args.agent),
  )
  // Wider than the final limit: fusion needs something to fuse. A leg that
  // ranks the right note ninth still lifts it once another leg agrees.
  const pool = Math.max(limit * 5, 40)

  const rankedIds = async (order: SQL, having?: SQL): Promise<string[]> => {
    const rows = await app.db
      .select({ id: memories.id })
      .from(memories)
      .where(having ? and(candidateWhere, having) : candidateWhere)
      .orderBy(order)
      .limit(pool)
    return rows.map((row) => row.id)
  }

  const legs: string[][] = []
  // Strict: the conjunction Postgres builds for a search box. Precise when it
  // hits, silent when it does not.
  legs.push(
    await rankedIds(
      sql`ts_rank_cd(tsv, websearch_to_tsquery('english', ${query})) desc`,
      sql`tsv @@ websearch_to_tsquery('english', ${query})`,
    ),
  )
  // Loose: any searchable word. This is the recall leg, and the one that was
  // missing. Skipped when the question was all stopwords — `to_tsquery('')`
  // raises rather than matching nothing.
  if (anyTerms) {
    legs.push(
      await rankedIds(
        sql`ts_rank_cd(tsv, to_tsquery('english', ${anyTerms})) desc`,
        sql`tsv @@ to_tsquery('english', ${anyTerms})`,
      ),
    )
  }
  // Semantic: what the question meant, for the notes that share no words with
  // it. Absent entirely when embeddings are unavailable, which is a supported
  // state — the two lexical legs still answer.
  if (queryVector) {
    legs.push(
      await rankedIds(
        sql`embedding <=> ${toVectorLiteral(queryVector)}::vector asc`,
        sql`embedding is not null`,
      ),
    )
  }

  const fused = reciprocalRankFusion(legs)
  const relevantIds = [...fused.keys()]
  if (relevantIds.length === 0) return []

  // --- Usefulness: unchanged, and still the other half of the score ---------
  // The half-lives are inlined, not bound: a parameter inside a CASE arrives
  // typed `text`, and `86400.0 * text` is not an operator Postgres has. They
  // are compile-time constants from HALF_LIFE_DAYS, never user input.
  const usefulness = sql<number>`(
        0.25 * (${memories.importance}::float / 5.0)
      + 0.20 * exp(-extract(epoch from (now() - coalesce(${memories.lastUsedAt}, ${memories.createdAt}))) /
          (86400.0 * case ${memories.kind}
             when 'episode' then ${sql.raw(String(HALF_LIFE_DAYS.episode))}
             when 'fact' then ${sql.raw(String(HALF_LIFE_DAYS.fact))}
             when 'reflection' then ${sql.raw(String(HALF_LIFE_DAYS.reflection))}
             else ${sql.raw(String(HALF_LIFE_DAYS.procedure))} end))
      + 0.10 * least(${memories.useCount}, 20)::float / 20.0
      )`.mapWith(Number)
  const candidates = await app.db
    .select({ note: memories, usefulness })
    .from(memories)
    .where(and(candidateWhere, inArray(memories.id, relevantIds)))

  const scored = candidates
    .map((row) => ({
      note: row.note,
      // The same 0.45 relevance / 0.55 usefulness balance the weighted sum
      // always had — only the relevance term is now worth trusting.
      score: 0.45 * normalizeFused(fused.get(row.note.id) ?? 0, legs.length) + row.usefulness,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  const picked = scored.map((r) => ({ ...r.note, score: r.score }))
  const ids = picked.map((n) => n.id)
  if (ids.length > 0) {
    const linked = await app.db
      .select({ note: memories })
      .from(memoryLinks)
      .innerJoin(memories, eq(memories.id, memoryLinks.toNote))
      .where(
        and(
          inArray(memoryLinks.fromNote, ids),
          isNull(memories.validUntil),
          eq(memories.status, 'active'),
          reachableBy(args.agent),
        ),
      )
      .limit(limit)
    for (const row of linked) {
      if (!picked.some((n) => n.id === row.note.id)) picked.push({ ...row.note, score: 0 })
    }
  }
  const usedIds = picked.map((n) => n.id)
  if (usedIds.length > 0) {
    await app.db
      .update(memories)
      .set({ lastUsedAt: new Date(), useCount: sql`${memories.useCount} + 1` })
      .where(inArray(memories.id, usedIds))
  }
  return picked
}

/** The always-in-prompt tier, cut at a hard character budget. */
export async function pinnedNotes(args: {
  tenantId: string
  agent: AgentBinding
  budgetChars?: number
}): Promise<(typeof memories.$inferSelect)[]> {
  const app = db()
  const rows = await app.db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.pinned, true),
        isNull(memories.validUntil),
        eq(memories.status, 'active'),
        reachableBy(args.agent),
      ),
    )
    .orderBy(desc(memories.importance), desc(memories.updatedAt))
  const budget = args.budgetChars ?? 16_000
  const out: (typeof memories.$inferSelect)[] = []
  let used = 0
  for (const row of rows) {
    used += row.title.length + row.body.length
    if (used > budget) break
    out.push(row)
  }
  return out
}

/** Rebind who a company note reaches. Agent-scope notes have no assignment. */
export async function setNoteAssignment(args: {
  tenantId: string
  noteId: string
  assignment: ResourceAssignment
}): Promise<void> {
  const app = db()
  await app.db
    .update(memories)
    .set({ assignment: args.assignment, updatedAt: new Date() })
    .where(and(eq(memories.id, args.noteId), eq(memories.scope, 'company')))
}

/** Backlinks: live notes whose body wikilinks to this one. */
export async function backlinksFor(tenantId: string, noteIds: string[]): Promise<Map<string, { id: string; title: string; slug: string }[]>> {
  const app = db()
  const map = new Map<string, { id: string; title: string; slug: string }[]>()
  if (noteIds.length === 0) return map
  const rows = await app.db
    .select({ to: memoryLinks.toNote, id: memories.id, title: memories.title, slug: memories.slug })
    .from(memoryLinks)
    .innerJoin(memories, eq(memories.id, memoryLinks.fromNote))
    .where(and(inArray(memoryLinks.toNote, noteIds), isNull(memories.validUntil)))
  for (const row of rows) {
    const list = map.get(row.to) ?? []
    list.push({ id: row.id, title: row.title, slug: row.slug })
    map.set(row.to, list)
  }
  return map
}

/** An agent (or a human on its behalf) nominates a note for company knowledge. */
export async function proposePromotion(args: {
  tenantId: string
  noteId: string
  rationale: string
  proposedByPersonId?: string
}): Promise<void> {
  const app = db()
  const [note] = await app.db.select().from(memories).where(eq(memories.id, args.noteId))
  if (!note) throw new Error('Note not found.')
  if (note.scope !== 'agent') throw new Error('Only agent notes can be promoted.')
  await app.db.insert(memoryProposals).values({
    tenantId: args.tenantId,
    kind: 'promote',
    noteId: args.noteId,
    payload: { title: note.title, body: note.body },
    rationale: args.rationale,
    proposedByPersonId: args.proposedByPersonId ?? note.personId,
  })
}

/** Human decision on a proposal. Approving a promotion creates the company
 *  note (citing the original) and supersedes the agent note by promotion.
 *  Approving a consolidator 'supersede' closes the old note behind a new one;
 *  approving an 'edit' applies the correction (prior head snapshotted).
 *  Everything stays append-only; rejections just close the proposal. */
export async function decideProposal(args: {
  tenantId: string
  proposalId: string
  approve: boolean
  decidedBy: string
}): Promise<void> {
  const app = db()
  const [proposal] = await app.db
    .select()
    .from(memoryProposals)
    .where(and(eq(memoryProposals.id, args.proposalId), eq(memoryProposals.status, 'open')))
  if (!proposal) throw new Error('Proposal already decided or not found.')
  if (!args.approve) {
    await app.db
      .update(memoryProposals)
      .set({ status: 'rejected', decidedBy: args.decidedBy, decidedAt: new Date() })
      .where(eq(memoryProposals.id, args.proposalId))
    return
  }
  if (proposal.kind === 'promote' && proposal.noteId) {
    const [note] = await app.db.select().from(memories).where(eq(memories.id, proposal.noteId))
    if (note && !note.validUntil) {
      const companyId = await createNote({
        tenantId: args.tenantId,
        scope: 'company',
        personId: null,
        kind: note.kind,
        title: proposal.payload.title ?? note.title,
        body: `${proposal.payload.body ?? note.body}\n\nPromoted from [[${note.slug}]].`,
        author: 'human',
        importance: note.importance,
      })
      await app.db
        .update(memories)
        .set({ validUntil: new Date(), supersededBy: companyId, pinned: false, updatedAt: new Date() })
        .where(eq(memories.id, note.id))
    }
  } else if (proposal.kind === 'supersede') {
    const targetId = proposal.payload.noteIds?.[0] ?? proposal.noteId
    if (!targetId) throw new Error('Supersede proposal has no target note.')
    const [note] = await app.db.select().from(memories).where(eq(memories.id, targetId))
    if (note && !note.validUntil) {
      await supersedeNote({
        tenantId: args.tenantId,
        oldNoteId: targetId,
        title: proposal.payload.title ?? note.title,
        body: proposal.payload.body ?? note.body,
        author: 'consolidator',
      })
    }
  } else if (proposal.kind === 'edit' && proposal.noteId) {
    const [note] = await app.db.select().from(memories).where(eq(memories.id, proposal.noteId))
    if (note && !note.validUntil) {
      await correctNote({
        tenantId: args.tenantId,
        noteId: proposal.noteId,
        title: proposal.payload.title ?? note.title,
        body: proposal.payload.body ?? note.body,
        editedBy: 'consolidator',
        reason: 'consolidator proposal',
      })
    }
  } else if (proposal.kind === 'merge') {
    // The gardener's merge: one surviving note absorbs the merged text
    // (a correction, prior head snapshotted); the rest close behind it,
    // same as any other supersession — never a delete.
    const noteIds = proposal.payload.noteIds ?? (proposal.noteId ? [proposal.noteId] : [])
    const survivorId = proposal.noteId ?? noteIds[0]
    if (survivorId) {
      const [survivor] = await app.db.select().from(memories).where(eq(memories.id, survivorId))
      if (survivor && !survivor.validUntil) {
        await correctNote({
          tenantId: args.tenantId,
          noteId: survivorId,
          title: proposal.payload.title ?? survivor.title,
          body: proposal.payload.body ?? survivor.body,
          editedBy: 'consolidator',
          reason: 'merge proposal',
        })
        const duplicateIds = noteIds.filter((noteId) => noteId !== survivorId)
        for (const duplicateId of duplicateIds) {
          await app.db
            .update(memories)
            .set({ validUntil: new Date(), supersededBy: survivorId, pinned: false, updatedAt: new Date() })
            .where(and(eq(memories.id, duplicateId), isNull(memories.validUntil)))
        }
      }
    }
  } else if (proposal.kind === 'expire' && proposal.noteId) {
    await expireNote(args.tenantId, proposal.noteId)
  }
  await app.db
    .update(memoryProposals)
    .set({ status: 'approved', decidedBy: args.decidedBy, decidedAt: new Date() })
    .where(eq(memoryProposals.id, args.proposalId))
}
