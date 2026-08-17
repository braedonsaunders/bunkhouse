'use client'

import { Avatar } from '@braedonsaunders/appkit-ui'
import { ComposedAvatar } from '@braedonsaunders/appkit-avatars/react'
import type { AvatarComposition, AvatarPart, AvatarPartCategory } from '@braedonsaunders/appkit-avatars/composition'

/**
 * A person's face wherever a small likeness is wanted — directory rows, the
 * org chart, mail.
 *
 * It is the head viewport of their one full-body composition, not a stored
 * portrait. Someone who has not been given a figure yet falls back to initials.
 */
export function RosterAvatar({
  name,
  composition,
  parts,
  categories,
  size = 26,
}: {
  name: string
  composition: AvatarComposition | null
  parts: AvatarPart[]
  categories: AvatarPartCategory[]
  size?: number
}) {
  if (!composition) return <Avatar name={name} size={size} />
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
