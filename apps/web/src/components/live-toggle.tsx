'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Switch } from '@braedonsaunders/appkit-ui'

/**
 * The observatory's live control: while on, re-fetches the current route's
 * server data every five seconds via router.refresh(). Purely a read poll —
 * no state is written, so toggling it is always safe.
 */
export function LiveToggle({ label = 'Live', defaultOn = false }: { label?: string; defaultOn?: boolean }) {
  const router = useRouter()
  const [live, setLive] = React.useState(defaultOn)

  React.useEffect(() => {
    if (!live) return
    const timer = setInterval(() => router.refresh(), 5000)
    return () => clearInterval(timer)
  }, [live, router])

  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-fg-muted">
      <Switch checked={live} onChange={(event) => setLive(event.target.checked)} />
      <span className="flex items-center gap-1.5">
        {live ? <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-success" aria-hidden /> : null}
        {label}
      </span>
    </label>
  )
}
