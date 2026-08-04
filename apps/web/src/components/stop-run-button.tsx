'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@appkit/ui'
import { stopRunAction } from '../app/runs/run-actions'

/**
 * Stopping a run from the record it belongs to.
 *
 * Two-press rather than a dialog: the confirmation is the same control saying
 * what it is about to do, which is enough for something that destroys no work
 * and can be read on the timeline afterwards. It reverts on its own if left
 * alone, so a stray click never sits there armed.
 */
export function StopRunButton({ runId, live }: { runId: string; live: boolean }) {
  const router = useRouter()
  const [armed, setArmed] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  React.useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(timer)
  }, [armed])

  return (
    <span className="flex items-center gap-2">
      {error ? <span className="text-xs text-danger">{error}</span> : null}
      <Button
        variant={armed ? 'destructive' : 'outline'}
        size="sm"
        disabled={busy}
        onClick={() => {
          if (!armed) {
            setArmed(true)
            setError(null)
            return
          }
          startBusy(async () => {
            const result = await stopRunAction(runId)
            setArmed(false)
            if (!result.ok) {
              setError(result.message)
              return
            }
            router.refresh()
          })
        }}
      >
        {busy ? 'Stopping…' : armed ? 'Confirm stop' : 'Stop'}
      </Button>
      {armed && live ? (
        <span className="text-xs text-fg-muted">Finishes the step it is on, then stops.</span>
      ) : null}
    </span>
  )
}
