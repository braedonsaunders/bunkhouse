'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Drawer } from '@appkit/ui'
import { SectionTabs, type SectionTabItem } from './section-tabs'

export type RunRecordTab = {
  key: string
  label: string
  /** Shown on the subtab chip — how many rows the section holds. */
  count?: number
  content: React.ReactNode
}

function useRunTabs(tabs: RunRecordTab[], initialTabKey?: string | undefined) {
  const [active, setActive] = React.useState(
    initialTabKey && tabs.some((tab) => tab.key === initialTabKey) ? initialTabKey : (tabs[0]?.key ?? 'overview'),
  )
  const items: SectionTabItem[] = tabs.map((tab) => ({
    key: tab.key,
    label: tab.label,
    ...(tab.count === undefined ? {} : { count: tab.count }),
  }))
  const current = tabs.find((tab) => tab.key === active) ?? tabs[0]
  return { items, current, setActive }
}

/**
 * The run record's sections, for hosts that are already a page (a deep link to
 * /runs/[id]). Identical navigation to the drawer, so the record reads the
 * same wherever it is opened.
 */
export function RunSubtabs({ tabs, initialTabKey }: { tabs: RunRecordTab[]; initialTabKey?: string | undefined }) {
  const { items, current, setActive } = useRunTabs(tabs, initialTabKey)
  return (
    <div className="space-y-4">
      <SectionTabs tabs={items} active={current?.key ?? ''} onSelect={setActive} ariaLabel="Run sections" />
      <div key={current?.key}>{current?.content}</div>
    </div>
  )
}

/**
 * The run record flyout: everything one unit of an agent's work produced —
 * its ledger, transcript, browser session, work product, approvals, cited
 * procedures, and spend — split into subtabs. Sections are server-rendered
 * nodes passed in, so nested client widgets keep working unchanged.
 */
export function RunDrawer({
  open,
  basePath,
  title,
  subtitle,
  badge,
  headerActions,
  tabs,
  initialTabKey,
}: {
  open: boolean
  /** The surface this record was opened from; closing returns there. */
  basePath: string
  title: string
  subtitle: string
  badge?: React.ReactNode
  headerActions?: React.ReactNode
  tabs: RunRecordTab[]
  /** Tab to land on, when the record was opened to show something specific. */
  initialTabKey?: string | undefined
}) {
  const router = useRouter()
  const { items, current, setActive } = useRunTabs(tabs, initialTabKey)

  return (
    <Drawer
      open={open}
      onClose={() => router.push(basePath, { scroll: false })}
      title={
        <span className="flex items-center gap-2">
          <span className="truncate">{title}</span>
          {badge}
        </span>
      }
      description={subtitle}
      headerActions={headerActions}
      size="2xl"
      subtabs={<SectionTabs tabs={items} active={current?.key ?? ''} onSelect={setActive} ariaLabel="Run sections" />}
    >
      <div key={current?.key}>{current?.content}</div>
    </Drawer>
  )
}
