import { asc, desc, eq } from 'drizzle-orm'
import { ROLE_PACKS } from '@bunkhouse/roles'
import { PageContainer, PageHeader } from '@appkit/ui'
import { people, procedureRevisions, procedures } from '../../../db/schema'
import { db } from '../../../db/client'
import { ProceduresView, type ProcedureRow } from '../../../components/procedures-view'
import { resolveTenantId } from '../../../lib/tenant'

export const dynamic = 'force-dynamic'

export default async function ProceduresPage() {
  const tenantId = await resolveTenantId()
  const app = db()
  const data = await app.withTenantContext(tenantId, async () => {
    const heads = await app.db.select().from(procedures).orderBy(asc(procedures.title))
    const revisions = await app.db.select().from(procedureRevisions).orderBy(desc(procedureRevisions.version))
    const hands = await app.db
      .select({ id: people.id, name: people.name })
      .from(people)
      .where(eq(people.kind, 'hand'))
      .orderBy(asc(people.name))
    return { heads, revisions, hands }
  })

  const handNames = new Map(data.hands.map((h) => [h.id, h.name]))
  const packTitles = new Map(ROLE_PACKS.map((p) => [p.slug, p.title]))
  const rows: ProcedureRow[] = data.heads.map((head) => {
    const revs = data.revisions.filter((r) => r.procedureId === head.id)
    const current = revs.find((r) => r.version === head.currentVersion)
    const appliesTo = head.assignment.everyone
      ? 'Everyone'
      : [
          ...(head.assignment.rolePacks ?? []).map((slug) => packTitles.get(slug) ?? slug),
          ...(head.assignment.personIds ?? []).map((id) => handNames.get(id) ?? 'a hand'),
        ].join(', ') || 'Nobody yet'
    return {
      id: head.id,
      slug: head.slug,
      title: head.title,
      status: head.status,
      version: head.currentVersion,
      appliesTo,
      updatedAt: head.updatedAt.toISOString().slice(0, 16).replace('T', ' '),
      body: current?.body ?? '',
      revisions: revs.map((r) => ({
        version: r.version,
        body: r.body,
        changeNote: r.changeNote ?? '',
        createdAt: r.createdAt.toISOString().slice(0, 16).replace('T', ' '),
      })),
      assignment: head.assignment,
    }
  })

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Procedures"
        description="Versioned company doctrine. Hands follow the active revision and cite it in their work — changes are new versions, never edits."
        back={{ href: '/admin', label: 'Admin' }}
      />
      <ProceduresView
        rows={rows}
        rolePackOptions={ROLE_PACKS.map((p) => ({ value: p.slug, label: p.title }))}
        handOptions={data.hands.map((h) => ({ value: h.id, label: h.name }))}
      />
    </PageContainer>
  )
}
