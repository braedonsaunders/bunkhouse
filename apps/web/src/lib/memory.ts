import 'server-only'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { memories, memoryLinks, memoryProposals, memoryRevisions } from '../db/schema'
import { db } from '../db/client'

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

export type CreateNoteInput = {
  tenantId: string
  scope: 'hand' | 'company'
  personId: string | null
  kind: NoteKind
  title: string
  body: string
  author: 'hand' | 'human' | 'consolidator'
  importance?: number
  pinned?: boolean
  sourceRunId?: string
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
      })
      .onConflictDoNothing()
      .returning({ id: memories.id })
    if (row) {
      await syncLinks(input.tenantId, row.id, input.personId, input.body)
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
}

/** Contradiction: new note supersedes the old; the old is closed, not deleted. */
export async function supersedeNote(args: {
  tenantId: string
  oldNoteId: string
  title: string
  body: string
  author: 'hand' | 'human' | 'consolidator'
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

export type RetrievedNote = typeof memories.$inferSelect & { score: number }

/**
 * The composite retrieval: relevance (FTS) + importance + recency + proven
 * usefulness, live notes only, then one hop of wikilink expansion. Marks
 * usage — notes earn their keep.
 */
export async function retrieveNotes(args: {
  tenantId: string
  personId: string
  query: string
  limit?: number
}): Promise<RetrievedNote[]> {
  const app = db()
  const limit = args.limit ?? 8
  const query = args.query.slice(0, 500)
  const scored = await app.db
    .select({
      note: memories,
      score: sql<number>`(
        0.45 * ts_rank_cd(tsv, websearch_to_tsquery('english', ${query}))
      + 0.25 * (${memories.importance}::float / 5.0)
      + 0.20 * exp(-extract(epoch from (now() - coalesce(${memories.lastUsedAt}, ${memories.createdAt}))) /
          (86400.0 * case ${memories.kind}
             when 'episode' then ${HALF_LIFE_DAYS.episode}
             when 'fact' then ${HALF_LIFE_DAYS.fact}
             when 'reflection' then ${HALF_LIFE_DAYS.reflection}
             else ${HALF_LIFE_DAYS.procedure} end))
      + 0.10 * least(${memories.useCount}, 20)::float / 20.0
      )`.mapWith(Number),
    })
    .from(memories)
    .where(
      and(
        isNull(memories.validUntil),
        eq(memories.status, 'active'),
        eq(memories.pinned, false),
        sql`(${memories.scope} = 'company' or ${memories.personId} = ${args.personId})`,
      ),
    )
    .orderBy(sql`2 desc`)
    .limit(limit)

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
          sql`(${memories.scope} = 'company' or ${memories.personId} = ${args.personId})`,
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
  personId: string
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
        sql`(${memories.scope} = 'company' or ${memories.personId} = ${args.personId})`,
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

/** A hand (or a human on its behalf) nominates a note for company knowledge. */
export async function proposePromotion(args: {
  tenantId: string
  noteId: string
  rationale: string
  proposedByPersonId?: string
}): Promise<void> {
  const app = db()
  const [note] = await app.db.select().from(memories).where(eq(memories.id, args.noteId))
  if (!note) throw new Error('Note not found.')
  if (note.scope !== 'hand') throw new Error('Only hand notes can be promoted.')
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
 *  note (citing the original) and supersedes the hand note by promotion.
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
  }
  await app.db
    .update(memoryProposals)
    .set({ status: 'approved', decidedBy: args.decidedBy, decidedAt: new Date() })
    .where(eq(memoryProposals.id, args.proposalId))
}
