import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  PageContainer,
  PageHeader,
  Select,
  Textarea,
} from '@appkit/ui'
import { memories, memoryProposals, people } from '../../../db/schema'
import { db } from '../../../db/client'
import { resolveTenantId } from '../../../lib/tenant'
import { deleteMemoryNote, togglePinNote, updateMemoryNote } from '../../people/actions'
import { addCompanyNote, decideMemoryProposal } from './actions'

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

      {data.proposals.length > 0 ? (
        <Card className="border-primary/50">
          <CardHeader>
            <CardTitle>Proposals</CardTitle>
            <CardDescription>Hands nominating knowledge for the whole company.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.proposals.map(({ proposal, proposerName }) => (
              <div key={proposal.id} className="rounded-md border border-border p-3 text-sm">
                <div className="mb-1 flex items-center gap-2">
                  <Badge variant="secondary">{proposal.kind}</Badge>
                  <span className="text-fg-muted">
                    from {proposerName ?? 'the consolidator'} ·{' '}
                    {proposal.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
                  </span>
                </div>
                <p className="font-medium">{proposal.payload.title}</p>
                <p className="whitespace-pre-wrap text-fg-muted">{proposal.payload.body}</p>
                <p className="mt-1 text-xs text-fg-muted">Rationale: {proposal.rationale}</p>
                <form action={decideMemoryProposal} className="mt-2 flex items-center gap-2">
                  <input type="hidden" name="proposalId" value={proposal.id} />
                  <Button type="submit" name="decision" value="approve" size="sm">
                    Approve
                  </Button>
                  <Button type="submit" name="decision" value="reject" variant="outline" size="sm">
                    Reject
                  </Button>
                </form>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Notes</CardTitle>
          <CardDescription>
            Pinned notes ride in every hand's prompt (budgeted); the rest are retrieved when relevant. Link notes with
            [[slug]].
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.notes.length === 0 ? (
            <EmptyState
              title="No company knowledge yet"
              description="Write the facts every hand should share — hours, policies, key vendors — or approve a hand's proposal."
            />
          ) : (
            data.notes.map((note) => (
              <div key={note.id} className="rounded-md border border-border p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant={note.kind === 'procedure' ? 'default' : 'outline'}>{note.kind}</Badge>
                  <Badge variant="outline">importance {note.importance}</Badge>
                  {note.pinned ? <Badge>pinned</Badge> : null}
                  <span className="text-fg-muted">[[{note.slug}]] · by {note.author}</span>
                </div>
                <form action={updateMemoryNote} className="space-y-2">
                  <input type="hidden" name="memoryId" value={note.id} />
                  <Input name="title" defaultValue={note.title} required />
                  <Textarea name="body" rows={2} defaultValue={note.body} required />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="submit" variant="outline" size="sm">
                      Save correction
                    </Button>
                    <Button type="submit" formAction={deleteMemoryNote} variant="outline" size="sm">
                      Forget
                    </Button>
                  </div>
                </form>
                <form action={togglePinNote} className="mt-2">
                  <input type="hidden" name="memoryId" value={note.id} />
                  <input type="hidden" name="pinned" value={note.pinned ? 'false' : 'true'} />
                  <Button type="submit" variant="outline" size="sm">
                    {note.pinned ? 'Unpin' : 'Pin to every prompt'}
                  </Button>
                </form>
              </div>
            ))
          )}
          <form action={addCompanyNote} className="space-y-2 rounded-md border border-dashed border-border p-3">
            <div className="flex gap-2">
              <Select name="kind" defaultValue="fact" aria-label="Note kind">
                <option value="fact">Fact</option>
                <option value="procedure">Procedure</option>
                <option value="reflection">Reflection</option>
                <option value="episode">Episode</option>
              </Select>
              <Input name="title" placeholder="Company hours" required className="flex-1" />
            </div>
            <Textarea name="body" rows={2} placeholder="What every hand should know. Link with [[slug]]." required />
            <Button type="submit" variant="outline" size="sm">
              Add to company knowledge
            </Button>
          </form>
        </CardContent>
      </Card>
    </PageContainer>
  )
}
