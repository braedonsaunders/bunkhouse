import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { PageContainer, PageHeader } from '@appkit/ui'
import { memories, memoryProposals } from '../../../db/schema'
import { db } from '../../../db/client'
import { resolveTenantId } from '../../../lib/tenant'
import { KnowledgeView } from '../../../components/knowledge-view'

export const dynamic = 'force-dynamic'

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
    return { notes, proposals }
  })

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Company knowledge"
        description="The governed shared layer every hand loads. Hands can only nominate — humans decide what crosses this boundary."
        back={{ href: '/admin', label: 'Admin' }}
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
          updatedAt: note.updatedAt.toISOString().slice(0, 16).replace('T', ' '),
        }))}
        proposals={data.proposals.map(({ proposal, proposerName }) => ({
          id: proposal.id,
          kind: proposal.kind,
          title: proposal.payload.title ?? '(untitled)',
          body: proposal.payload.body ?? '',
          rationale: proposal.rationale,
          from: proposerName ?? 'consolidator',
          createdAt: proposal.createdAt.toISOString().slice(0, 16).replace('T', ' '),
        }))}
      />
    </PageContainer>
  )
}
