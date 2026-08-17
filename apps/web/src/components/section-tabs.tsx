'use client'

import * as React from 'react'
import { Tabs, cn, type SubtabItem } from '@braedonsaunders/appkit-ui'

export type SectionTabItem = SubtabItem

/**
 * Every section switcher in the app: the segmented control, with the counts the
 * underline subtabs used to carry. One component so the whole app switches
 * sections the same way — a page's tabs, a settings pane's, and a record
 * drawer's are the same control at the same size.
 */
export function SectionTabs({
  tabs,
  active,
  onSelect,
  ariaLabel,
  className,
}: {
  tabs: SectionTabItem[]
  active: string
  onSelect?: (key: string) => void
  ariaLabel?: string
  className?: string
}) {
  const host = React.useRef<HTMLDivElement>(null)

  // Tabs owns the `role="tablist"` element but takes no accessible name, and a
  // page with several tab bars needs each one named. Set it on the real
  // tablist rather than a wrapper, which would name a group instead.
  React.useEffect(() => {
    const list = host.current?.querySelector('[role="tablist"]')
    if (list && ariaLabel) list.setAttribute('aria-label', ariaLabel)
  }, [ariaLabel])

  return (
    // The segmented control sizes to its options and does not scroll. A record
    // drawer with ten sections would clip on a narrow screen, so the rail
    // scrolls instead of the tabs disappearing.
    <div ref={host} className={cn('max-w-full overflow-x-auto', className)}>
      <Tabs
        tabs={tabs.map((tab) => ({
          value: tab.key,
          label:
            typeof tab.count === 'number' ? (
              <span className="flex items-center gap-1.5">
                {tab.label}
                <span className="text-xs tabular-nums text-fg-muted">{tab.count}</span>
              </span>
            ) : (
              tab.label
            ),
        }))}
        value={active}
        onValueChange={(value) => onSelect?.(value)}
      />
    </div>
  )
}
