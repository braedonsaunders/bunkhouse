'use client'

import Link from 'next/link'
import { Phone } from 'lucide-react'
import { Button } from '@braedonsaunders/appkit-ui'
import type { CallAction } from '../lib/call-action'

/**
 * The Call action wherever an agent is shown. `compact` is the in-row form —
 * icon only, sized to the roster row so the table keeps its rhythm — and the
 * click never reaches the row underneath, which opens the record drawer.
 */
export function CallActionButton({
  action,
  name,
  compact = false,
}: {
  action: CallAction
  /** Whose record this is, for the icon-only button's accessible name. */
  name: string
  compact?: boolean
}) {
  const label = `Call ${name}`
  const size = compact ? ('icon' as const) : ('sm' as const)
  const variant = compact ? ('ghost' as const) : ('default' as const)
  const className = compact ? 'size-7' : undefined

  if (action.disabledReason !== null) {
    return (
      // A disabled button takes no pointer events, so the reason has to hang
      // on a wrapper that can still be hovered.
      <span title={action.disabledReason} className="inline-flex">
        <Button size={size} variant={variant} className={className} disabled aria-label={compact ? label : undefined}>
          <Phone className="size-4" />
          {compact ? null : 'Call'}
        </Button>
      </span>
    )
  }

  return (
    <Button asChild size={size} variant={variant} className={className}>
      <Link
        href={action.href}
        prefetch={false}
        title={label}
        aria-label={compact ? label : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <Phone className="size-4" />
        {compact ? null : 'Call'}
      </Link>
    </Button>
  )
}
