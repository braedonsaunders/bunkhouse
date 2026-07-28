'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Badge, Drawer, SubtabNav, type SubtabItem } from '@appkit/ui'

export type PersonDrawerTab = {
  key: string
  label: string
  content: React.ReactNode
  /**
   * Give the tab the drawer's full height and let it own its own scrolling —
   * for workbenches like the avatar composer, which are laid out as panels
   * rather than as a column of cards.
   */
  fill?: boolean
}

/**
 * The person record flyout: everything about an agent or human lives here,
 * split into subtabs. Sections are server-rendered nodes passed in, so
 * server actions and nested client widgets keep working unchanged.
 */
export function PersonDrawer({
  open,
  basePath,
  name,
  subtitle,
  kind,
  status,
  avatar,
  avatarTabKey,
  initialTabKey,
  tabs,
}: {
  open: boolean
  /** The surface this record was opened from; closing returns there. */
  basePath: string
  name: string
  subtitle: string
  kind: 'agent' | 'human'
  status: string
  avatar: React.ReactNode
  /** Tab the header portrait opens, so the face is a way into its own editor. */
  avatarTabKey?: string
  /** Tab to land on, when the record was opened to show something specific. */
  initialTabKey?: string | undefined
  tabs: PersonDrawerTab[]
}) {
  const router = useRouter()
  const [active, setActive] = React.useState(
    initialTabKey && tabs.some((tab) => tab.key === initialTabKey) ? initialTabKey : (tabs[0]?.key ?? 'overview'),
  )
  const items: SubtabItem[] = tabs.map((tab) => ({ key: tab.key, label: tab.label }))
  const current = tabs.find((tab) => tab.key === active) ?? tabs[0]
  const fills = Boolean(current?.fill)

  return (
    <Drawer
      open={open}
      onClose={() => router.push(basePath, { scroll: false })}
      title={
        <span className="flex items-center gap-2">
          {name}
          <Badge variant={kind === 'agent' ? 'default' : 'secondary'}>{kind === 'agent' ? 'Agent' : 'Human'}</Badge>
          <Badge variant={status === 'active' ? 'default' : 'outline'}>{status}</Badge>
        </span>
      }
      description={subtitle}
      headerActions={
        avatarTabKey && tabs.some((tab) => tab.key === avatarTabKey) ? (
          <button
            type="button"
            onClick={() => setActive(avatarTabKey)}
            title={`Compose ${name}'s avatar`}
            className="rounded-full transition-opacity hover:opacity-80"
          >
            {avatar}
          </button>
        ) : (
          avatar
        )
      }
      size="2xl"
      bodyClassName={fills ? 'flex min-h-0 flex-1 flex-col overflow-hidden px-6 py-5' : undefined}
    >
      <div className={fills ? 'flex h-full min-h-0 flex-col gap-4' : 'space-y-4'}>
        <div className="shrink-0">
          <SubtabNav tabs={items} active={current?.key ?? ''} onSelect={setActive} ariaLabel="Person sections" />
        </div>
        <div key={current?.key} className={fills ? 'min-h-0 flex-1 overflow-hidden' : undefined}>
          {current?.content}
        </div>
      </div>
    </Drawer>
  )
}
