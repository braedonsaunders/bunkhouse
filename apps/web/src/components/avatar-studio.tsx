'use client'

import * as React from 'react'
import Link from 'next/link'
import { Button } from '@braedonsaunders/appkit-ui'
import { AvatarComposer, ComposedAvatar } from '@braedonsaunders/appkit-avatars/react'
import type { AvatarComposition, AvatarPart, AvatarPartCategory } from '@braedonsaunders/appkit-avatars/composition'
import { saveAvatarCompositionAction } from '../app/organization/avatar-actions'
import { generateAvatarPartsAction, keepAvatarPartAction } from '../app/admin/settings/avatar-part-actions'

/**
 * A person's likeness: one full-body figure, composed from the company's
 * parts library.
 *
 * This is the Avatar subtab of the person record — a workbench with the same
 * standing as Voice or Duties, not a drawer stacked on a drawer. The portrait
 * in the record header is this same figure cropped to its head viewport, so
 * what an operator arranges here is literally what appears in the directory,
 * on the org chart, in the lobby, and on a call.
 */
export function AvatarStudio({
  personId,
  name,
  composition,
  parts,
  categories,
}: {
  personId: string
  name: string
  composition: AvatarComposition
  parts: AvatarPart[]
  categories: AvatarPartCategory[]
}) {
  const [saving, startSaving] = React.useTransition()
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)

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
    <div className="flex h-full min-h-0 flex-col gap-3">
      {error ? <p className="shrink-0 text-sm text-danger">{error}</p> : null}
      <AvatarComposer
        composition={composition}
        parts={parts}
        categories={categories}
        onSave={save}
        saving={saving}
        saveLabel={saved ? 'Saved' : 'Save avatar'}
        subjectName={name}
        generator={{
          generate: (categoryId, description) => generateAvatarPartsAction(categoryId, description),
          keep: async (input) => {
            const result = await keepAvatarPartAction({ ...input, tags: [] })
            if (!result.ok) return result
            // Hand the freshly kept part straight back so the composer can
            // place it without waiting for a page refresh.
            return {
              ok: true,
              part: {
                id: result.partId,
                categoryId: input.categoryId,
                name: input.name,
                imageUrl: `/api/avatar-parts/${result.partId}`,
                tags: [],
              },
            }
          },
        }}
        generateAction={
          <Button asChild size="sm" variant="outline">
            <Link href="/admin/settings?section=avatar-parts">Open the parts library</Link>
          </Button>
        }
      />
    </div>
  )
}

/**
 * The person's face in the record header — their figure cropped to its head
 * viewport. There is no second stored portrait; this is the same composition
 * the Avatar subtab edits.
 */
export function AvatarPortrait({
  name,
  composition,
  parts,
  categories,
  size = 44,
}: {
  name: string
  composition: AvatarComposition
  parts: AvatarPart[]
  categories: AvatarPartCategory[]
  size?: number
}) {
  return (
    <ComposedAvatar
      composition={composition}
      parts={parts}
      categories={categories}
      variant="head"
      size={size}
      rounded
      name={name}
    />
  )
}
