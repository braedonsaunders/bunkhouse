'use client'

import * as React from 'react'
import Link from 'next/link'
import { Button, Drawer } from '@appkit/ui'
import { AvatarComposer, ComposedAvatar } from '@appkit/avatars/react'
import type { AvatarComposition, AvatarPart, AvatarPartCategory } from '@appkit/avatars/composition'
import { saveAvatarCompositionAction } from '../app/organization/avatar-actions'

/**
 * A person's likeness: one full-body figure, composed from the company's
 * parts library.
 *
 * The avatar in the drawer header is that same figure cropped to its head
 * viewport, so what an operator arranges here is literally what appears in the
 * directory, on the org chart, in the lobby, and on a call. Clicking it opens
 * the composer.
 */
export function AvatarStudio({
  personId,
  name,
  composition,
  parts,
  categories,
  size = 44,
}: {
  personId: string
  name: string
  composition: AvatarComposition
  parts: AvatarPart[]
  categories: AvatarPartCategory[]
  size?: number
}) {
  const [open, setOpen] = React.useState(false)
  const [saving, startSaving] = React.useTransition()
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)
  const [current, setCurrent] = React.useState(composition)

  const save = (next: AvatarComposition) =>
    startSaving(async () => {
      setError(null)
      const result = await saveAvatarCompositionAction(personId, next)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    })

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Compose ${name}'s avatar`}
        className="rounded-full transition-opacity hover:opacity-80"
      >
        <ComposedAvatar
          composition={current}
          parts={parts}
          categories={categories}
          variant="head"
          size={size}
          rounded
          name={name}
        />
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={`Avatar — ${name}`}
        description="One full-body figure, built from the company parts library. Every portrait in the app is a crop of it."
        size="xl"
      >
        <div className="space-y-3">
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <AvatarComposer
            composition={composition}
            parts={parts}
            categories={categories}
            onChange={setCurrent}
            onSave={save}
            saving={saving}
            saveLabel={saved ? 'Saved' : 'Save avatar'}
            subjectName={name}
            generateAction={
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/settings?section=avatar-parts">Open the parts library</Link>
              </Button>
            }
          />
        </div>
      </Drawer>
    </>
  )
}
