'use client'

import * as React from 'react'
import { Alert, AlertDescription, Button } from '@braedonsaunders/appkit-ui'
import { updatePerson, type PersonUpdateResult } from '../app/organization/actions'

/**
 * The record form's submit shell. The fields are server-rendered and passed in
 * as children; this only owns submission, so a rejected edit — a reporting line
 * that would close a loop, an email already taken — comes back as a sentence
 * above the Save button instead of throwing the operator onto an error page.
 */
export function PersonRecordForm({ children }: { children: React.ReactNode }) {
  const [state, formAction, pending] = React.useActionState<PersonUpdateResult | null, FormData>(
    async (_previous, formData) => updatePerson(formData),
    null,
  )

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-2">
      {children}
      {state && !state.ok ? (
        <Alert variant="destructive" className="sm:col-span-2">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}
      <div className="sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save record'}
        </Button>
      </div>
    </form>
  )
}
