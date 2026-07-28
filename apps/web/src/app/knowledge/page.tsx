import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { ROLE_PACKS } from '@bunkhouse/roles'
import { PageContainer, PageHeader } from '@appkit/ui'
import { memories, memoryProposals, people, procedureRevisions, procedures } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId } from '../../lib/tenant'
import { KnowledgeView } from '../../components/knowledge-view'
import type { ProcedureRow } from '../../components/procedures-view'

export const dynamic = 'force-dynamic'

const stamp = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ')

export default async function KnowledgePage() {
  const tenantId = await resolveTenantId()
  const app = db()
  const data = await app.withTenantContext(tenantId, async () => {
    const notes = await app.db
      .select()
      .from(memories)
      .where(and(eq(memories.scope, 'company'), isNull(memories.validUntil), eq(memories.status, 'active')))
      .orderBy(desc(memories.pinned), asc(memories.title))
    // Open proposals await a decision; a gardener finding that was safe
    // enough to auto-apply still shows up (read-only) for the audit trail —
    // its silent "nothing needed doing" marker rows do not (empty noteIds).
    const proposals = await app.db
      .select({
        proposal: memoryProposals,
        proposerName: sql<string | null>`(select name from people p where p.id = ${memoryProposals.proposedByPersonId})`,
      })
      .from(memoryProposals)
      .where(
        or(
          eq(memoryProposals.status, 'open'),
          and(
            eq(memoryProposals.status, 'auto_applied'),
            sql`${memoryProposals.payload} ->> 'origin' = 'gardener'`,
            sql`jsonb_array_length(coalesce(${memoryProposals.payload} -> 'noteIds', '[]'::jsonb)) > 0`,
          ),
        ),
      )
      .orderBy(sql`case when ${memoryProposals.status} = 'open' then 0 else 1 end`, desc(memoryProposals.createdAt))
      .limit(200)

    // The notes each proposal references (payload.noteIds) — fetched once so
    // the drawer can render a real before/after diff instead of just the
    // proposed text on its own.
    const refIds = new Set<string>()
    for (const { proposal } of proposals) {
      for (const refId of proposal.payload.noteIds ?? []) refIds.add(refId)
    }
    const refNotes =
      refIds.size > 0
        ? await app.db
            .select({ id: memories.id, slug: memories.slug, title: memories.title, body: memories.body })
            .from(memories)
            .where(inArray(memories.id, [...refIds]))
        : []
    const refNoteById = new Map(refNotes.map((n) => [n.id, n]))

    const procedureHeads = await app.db.select().from(procedures).orderBy(asc(procedures.title))
    const revisions = await app.db.select().from(procedureRevisions).orderBy(desc(procedureRevisions.version))
    const agents = await app.db
      .select({ id: people.id, name: people.name })
      .from(people)
      .where(eq(people.kind, 'agent'))
      .orderBy(asc(people.name))
    return { notes, proposals, refNoteById, procedureHeads, revisions, agents }
  })

  const agentNames = new Map(data.agents.map((h) => [h.id, h.name]))
  const packTitles = new Map(ROLE_PACKS.map((p) => [p.slug, p.title]))
  const procedureRows: ProcedureRow[] = data.procedureHeads.map((head) => {
    const revs = data.revisions.filter((r) => r.procedureId === head.id)
    const current = revs.find((r) => r.version === head.currentVersion)
    const appliesTo = head.assignment.everyone
      ? 'Everyone'
      : [
          ...(head.assignment.rolePacks ?? []).map((slug) => packTitles.get(slug) ?? slug),
          ...(head.assignment.personIds ?? []).map((id) => agentNames.get(id) ?? 'an agent'),
        ].join(', ') || 'Nobody yet'
    return {
      id: head.id,
      slug: head.slug,
      title: head.title,
      status: head.status,
      version: head.currentVersion,
      appliesTo,
      updatedAt: stamp(head.updatedAt),
      body: current?.body ?? '',
      content: current?.content ?? null,
      steps: current?.content?.steps.length ?? 0,
      revisions: revs.map((r) => ({
        version: r.version,
        body: r.body,
        content: r.content ?? null,
        changeNote: r.changeNote ?? '',
        createdAt: stamp(r.createdAt),
      })),
      assignment: head.assignment,
    }
  })

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Company knowledge"
        description="The governed shared layer every agent loads: the notes they read, the procedures they follow, and the changes they nominate. Agents can only nominate — humans decide what crosses this boundary."
      />

      <KnowledgeView
        notes={data.notes.map((note) => ({
          id: note.id,
          slug: note.slug,
          kind: note.kind,
          title: note.title,
          body: note.body,
          importance: note.importance,
          pinned: note.pinned,
          author: note.author,
          updatedAt: stamp(note.updatedAt),
        }))}
        proposals={data.proposals.map(({ proposal, proposerName }) => {
          const housekeeping = proposal.payload.origin === 'gardener'
          return {
            id: proposal.id,
            kind: proposal.kind,
            title: proposal.payload.title ?? '(untitled)',
            body: proposal.payload.body ?? '',
            rationale: proposal.rationale,
            from: proposerName ?? (housekeeping ? 'Housekeeping' : 'consolidator'),
            createdAt: stamp(proposal.createdAt),
            status: proposal.status as 'open' | 'auto_applied',
            decidedAt: proposal.decidedAt ? stamp(proposal.decidedAt) : null,
            housekeeping,
            refs: (proposal.payload.noteIds ?? [])
              .map((refId) => data.refNoteById.get(refId))
              .filter((ref): ref is { id: string; slug: string; title: string; body: string } => Boolean(ref)),
          }
        })}
        procedures={procedureRows}
        rolePackOptions={ROLE_PACKS.map((p) => ({ value: p.slug, label: p.title }))}
        agentOptions={data.agents.map((h) => ({ value: h.id, label: h.name }))}
      />
    </PageContainer>
  )
}
