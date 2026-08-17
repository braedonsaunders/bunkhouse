import { notFound } from 'next/navigation'
import { DetailHeader, PageContainer } from '@braedonsaunders/appkit-ui'
import { resolveTenantId } from '../../../lib/tenant'
import { RunSubtabs } from '../../../components/run-drawer'
import { LiveToggle } from '../../../components/live-toggle'
import { loadRunRecord, runStatusBadge } from '../run-record'

export const dynamic = 'force-dynamic'

/**
 * A run as its own page — the deep link. The observatory opens the same
 * record as a flyout; both render the sections from `loadRunRecord`, so there
 * is one definition of what a run record contains.
 */
export default async function RunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ from?: string; tab?: string }>
}) {
  const { id } = await params
  const { from, tab } = await searchParams
  const tenantId = await resolveTenantId('work.read')

  const view = await loadRunRecord({ tenantId, runId: id })
  if (!view) notFound()

  return (
    <PageContainer className="space-y-6">
      <DetailHeader
        back={
          from === 'person' && view.agent
            ? { href: `/organization?person=${view.agent.id}`, label: view.agent.name }
            : { href: '/observatory', label: 'Observatory' }
        }
        title={view.title}
        subtitle={view.subtitle}
        badge={runStatusBadge(view.status)}
        actions={view.isOpen ? <LiveToggle defaultOn /> : undefined}
      />
      <RunSubtabs tabs={view.tabs} initialTabKey={tab} />
    </PageContainer>
  )
}
