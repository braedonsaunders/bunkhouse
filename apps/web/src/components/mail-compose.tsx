'use client'

import * as React from 'react'
import { PenLine } from 'lucide-react'
import { Button, Drawer, Input, Label, Textarea } from '@appkit/ui'
import { composeAction } from '../app/mail/actions'

/**
 * Compose from the selected mailbox: the operator writes as the agent (manual
 * assist / takeover). The message goes out over the agent's own account and
 * lands in the same thread ledger everything else uses.
 */
export function MailCompose({ accountId, address }: { accountId: string; address: string }) {
  const [open, setOpen] = React.useState(false)
  const [sending, startSending] = React.useTransition()
  const [error, setError] = React.useState<string | null>(null)

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        <PenLine className="mr-1.5 size-4" /> New message
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="New message"
        description={`Sends from ${address}.`}
        size="lg"
      >
        <form
          className="space-y-4"
          action={(formData) =>
            startSending(async () => {
              setError(null)
              try {
                await composeAction(formData)
                setOpen(false)
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'The message could not be sent.')
              }
            })
          }
        >
          <input type="hidden" name="accountId" value={accountId} />
          <div className="space-y-2">
            <Label htmlFor="compose-to">To</Label>
            <Input id="compose-to" name="to" type="email" placeholder="name@company.com" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="compose-subject">Subject</Label>
            <Input id="compose-subject" name="subject" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="compose-body">Message</Label>
            <Textarea id="compose-body" name="text" rows={10} required />
          </div>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <Button type="submit" disabled={sending}>
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </form>
      </Drawer>
    </>
  )
}
