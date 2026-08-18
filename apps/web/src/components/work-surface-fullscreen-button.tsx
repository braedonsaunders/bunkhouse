'use client'

import { Maximize2, Minimize2 } from 'lucide-react'
import { Button } from '@braedonsaunders/appkit-ui'

/** One fullscreen affordance shared by every observable agent work surface. */
export function WorkSurfaceFullscreenButton({
  expanded,
  onToggle,
  surface,
  shortcut,
}: {
  expanded: boolean
  onToggle: () => void
  surface: 'browser' | 'desktop' | 'terminal'
  shortcut?: string
}) {
  const action = expanded ? 'Exit' : 'Open'
  const label = `${action} ${surface} fullscreen`
  const title = shortcut ? `${label} (${shortcut})` : label
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7 shrink-0"
      aria-label={label}
      aria-pressed={expanded}
      title={title}
      onClick={onToggle}
    >
      {expanded ? <Minimize2 aria-hidden className="size-4" /> : <Maximize2 aria-hidden className="size-4" />}
    </Button>
  )
}
