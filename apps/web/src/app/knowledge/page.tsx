import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
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
    const proposals = await app.db
      .select({
        proposal: memoryProposals,
        proposerName: sql<string | null>`(select name from people p where p.id = ${memoryProposals.proposedByPersonId})`,
      })
      .from(memoryProposals)
      .where(eq(memoryProposals.status, 'open'))
      .orderBy(asc(memoryProposals.createdAt))
    const procedureHeads = await app.db.select().from(procedures).orderBy(asc(procedures.title))
    const revisions = await app.db.select().from(procedureRevisions).orderBy(desc(procedureRevisions.version))
    const agents = await app.db
      .select({ id: people.id, name: people.name })
      .from(people)
      .where(eq(people.kind, 'agent'))
      .orderBy(asc(people.name))
    return { notes, proposals, procedureHeads, revisions, agents }
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
        proposals={data.proposals.map(({ proposal, proposerName }) => ({
          id: proposal.id,
          kind: proposal.kind,
          title: proposal.payload.title ?? '(untitled)',
          body: proposal.payload.body ?? '',
          rationale: proposal.rationale,
          from: proposerName ?? 'consolidator',
          createdAt: stamp(proposal.createdAt),
        }))}
        procedures={procedureRows}
        rolePackOptions={ROLE_PACKS.map((p) => ({ value: p.slug, label: p.title }))}
        agentOptions={data.agents.map((h) => ({ value: h.id, label: h.name }))}
      />
    </PageContainer>
  )
}
