'use client'

import * as React from 'react'
import { Button, confirmDialog, toast } from '@braedonsaunders/appkit-ui'
import { setPersonStatusAction, type PersonStatus } from '../app/organization/actions'

/**
 * Stand an agent down, or bring one back — from the roster row, without opening
 * the record. Nobody is deleted: an agent that has stopped working is
 * offboarded, which keeps its runs, its mail, and its decisions on the record.
 * Offboarding cancels work in flight, so it asks first.
 */
export function PersonStatusAction({
  id,
  name,
  status,
}: {
  id: string
  name: string
  status: PersonStatus
}) {
  const [pending, startTransition] = React.useTransition()
  const offboarding = status !== 'offboarded'

  const run = async (event: React.MouseEvent) => {
    // The row underneath opens the record; this button is a different verb.
    event.stopPropagation()
    if (offboarding) {
      const confirmed = await confirmDialog({
        tone: 'danger',
        title: `Offboard ${name}?`,
        message:
          'Their mailbox stops syncing, standing duties are turned off, work in flight is cancelled, and anything they had waiting for approval expires. The record and its history are kept, and they can be re-onboarded later.',
        confirmLabel: 'Offboard',
      })
      if (!confirmed) return
    }
    startTransition(async () => {
      const form = new FormData()
      form.set('personId', id)
      // Coming back is a re-onboarding, never a silent flip to active: the
      // mailbox, duties, and autonomy dial all have to be switched on again
      // deliberately, because offboarding switched them off.
      form.set('status', offboarding ? 'offboarded' : 'onboarding')
      const result = await setPersonStatusAction(form)
      if (result.ok) {
        toast.success(offboarding ? `${name} was offboarded.` : `${name} is being onboarded again.`)
      } else {
        toast.error(result.message ?? 'That change could not be saved.')
      }
    })
  }

  return (
    <Button type="button" size="sm" variant={offboarding ? 'ghost' : 'outline'} disabled={pending} onClick={run}>
      {offboarding ? 'Offboard' : 'Reinstate'}
    </Button>
  )
}
