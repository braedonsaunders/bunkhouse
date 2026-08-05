'use client'

import * as React from 'react'
import { Alert, AlertDescription, Button, Label, Select } from '@appkit/ui'
import {
  setPersonAccountAction,
  type PersonAccountResult,
} from '../app/organization/actions'
import type { PersonAccountOption } from '../lib/person-accounts'

export function PersonAccountForm({
  personId,
  currentUserId,
  accounts,
}: {
  personId: string
  currentUserId: string | null
  accounts: PersonAccountOption[]
}) {
  const [state, action, pending] = React.useActionState<PersonAccountResult | null, FormData>(
    async (_previous, formData) => setPersonAccountAction(formData),
    null,
  )

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="personId" value={personId} />
      <div className="space-y-2">
        <Label htmlFor={`person-account-${personId}`}>Workspace account</Label>
        <Select id={`person-account-${personId}`} name="userId" defaultValue={currentUserId ?? ''}>
          <option value="">No login account</option>
          {accounts.map((account) => {
            const linkedElsewhere = Boolean(account.linkedPersonId && account.linkedPersonId !== personId)
            return (
              <option key={account.userId} value={account.userId} disabled={linkedElsewhere}>
                {account.name} — {account.email}
                {linkedElsewhere ? ` (linked to ${account.linkedPersonName})` : ''}
              </option>
            )
          })}
        </Select>
        <p className="text-xs text-fg-muted">
          Linking does not change this person’s work email. It identifies which signed-in colleague they are during
          calls, approvals, and other recorded work.
        </p>
      </div>
      {state && !state.ok ? (
        <Alert variant="destructive">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save access'}
      </Button>
    </form>
  )
}
