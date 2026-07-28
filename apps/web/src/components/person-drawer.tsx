'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Badge, Drawer, SubtabNav, type SubtabItem } from '@appkit/ui'

export type PersonDrawerTab = {
  key: string
  label: string
  content: React.ReactNode
}

/**
 * The person record flyout: everything about a hand or human lives here,
 * split into subtabs. Sections are server-rendered nodes passed in, so
 * server actions and nested client widgets keep working unchanged.
 */
export function PersonDrawer({
  open,
  name,
  subtitle,
  kind,
  status,
  avatar,
  tabs,
}: {
  open: boolean
  name: string
  subtitle: string
  kind: 'hand' | 'human'
  status: string
  avatar: React.ReactNode
  tabs: PersonDrawerTab[]
}) {
  const router = useRouter()
  const [active, setActive] = React.useState(tabs[0]?.key ?? 'overview')
  const items: SubtabItem[] = tabs.map((tab) => ({ key: tab.key, label: tab.label }))
  const current = tabs.find((tab) => tab.key === active) ?? tabs[0]

  return (
    <Drawer
      open={open}
      onClose={() => router.push('/people', { scroll: false })}
      title={
        <span className="flex items-center gap-2">
          {name}
          <Badge variant={kind === 'hand' ? 'default' : 'secondary'}>{kind === 'hand' ? 'Hand' : 'Human'}</Badge>
          <Badge variant={status === 'active' ? 'default' : 'outline'}>{status}</Badge>
        </span>
      }
      description={subtitle}
      headerActions={avatar}
      size="2xl"
    >
      <div className="space-y-4">
        <SubtabNav tabs={items} active={current?.key ?? ''} onSelect={setActive} ariaLabel="Person sections" />
        <div key={current?.key}>{current?.content}</div>
      </div>
    </Drawer>
  )
}
