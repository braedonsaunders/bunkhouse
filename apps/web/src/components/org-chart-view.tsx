'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { OrgChart, canReparent, toast, type OrgChartNode } from '@braedonsaunders/appkit-ui'
import { setReportsTo } from '../app/organization/actions'

type Move = { childId: string; managerId: string | null }

/**
 * The reporting hierarchy, live. Dragging a card onto another commits the new
 * reporting line immediately — the same write the record form makes. The move
 * is optimistic only for the length of the transition: if the server refuses
 * it, the chart snaps back to what is actually stored.
 */
export function OrgChartView({
  people,
  selectedId,
  toolbar,
  agentIds,
}: {
  people: OrgChartNode[]
  agentIds: string[]
  selectedId?: string | undefined
  toolbar?: React.ReactNode
}) {
  const router = useRouter()
  const [pending, startTransition] = React.useTransition()
  const [nodes, applyMove] = React.useOptimistic(people, (current: OrgChartNode[], move: Move) =>
    current.map((node) => (node.id === move.childId ? { ...node, parentId: move.managerId } : node)),
  )

  const reparent = (childId: string, managerId: string | null) => {
    if (!canReparent(nodes, childId, managerId)) return
    const child = nodes.find((node) => node.id === childId)
    const manager = nodes.find((node) => node.id === managerId)
    startTransition(async () => {
      applyMove({ childId, managerId })
      const result = await setReportsTo(childId, managerId)
      if (!result.ok) {
        toast.error('Reporting line unchanged', { description: result.message })
        return
      }
      toast.success(
        manager
          ? `${child?.name} now reports to ${manager.name}`
          : `${child?.name} now sits at the top level`,
      )
      router.refresh()
    })
  }

  return (
    <OrgChart
      nodes={nodes}
      selectedId={selectedId ?? null}
      onSelect={(id) =>
        router.push(agentIds.includes(id) ? `/organization/${id}` : `/organization/chart?person=${id}`, {
          scroll: false,
        })
      }
      onReparent={reparent}
      labels={{
        topLevel: 'Top level',
        topLevelHint: 'Drop here to remove their manager',
        reports: 'direct reports',
      }}
      toolbar={
        <div className="flex items-center gap-3">
          {pending ? <span className="text-xs text-fg-muted">Saving…</span> : null}
          {/* Keyed: the page builds this on the server, and an element that
              arrives across the RSC boundary is validated as a list child
              here. A Fragment carries the key without adding a DOM node. */}
          {toolbar ? <React.Fragment key="page-toolbar">{toolbar}</React.Fragment> : null}
        </div>
      }
    />
  )
}
