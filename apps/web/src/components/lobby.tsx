'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { CharacterScene, type SceneCharacter } from '@appkit/scene'
import { ComposedAvatar } from '@appkit/avatars/react'
import type { AvatarComposition, AvatarPart, AvatarPartCategory } from '@appkit/avatars/composition'

/**
 * A stable, person-specific walking pace. Randomising per render made the
 * crowd re-shuffle on every re-render; hashing the id gives the same variety
 * and holds still.
 */
function paceFor(id: string): number {
  let hash = 0
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) % 1000
  return 0.8 + (hash / 1000) * 0.5
}

export type LobbyPerson = {
  id: string
  name: string
  /** Their one figure. Anyone without a composition still walks, as initials. */
  composition?: AvatarComposition
  status?: { label: string; tone: 'active' | 'busy' | 'idle' }
  idleAnimation?: 'bounce' | 'sway' | 'still' | 'dance'
  walkSpeed?: number
}

/**
 * The bunkhouse floor: everyone who works here, milling about. Clicking a
 * figure opens their record. The overlay content sits in a zone the walkers
 * keep clear of.
 *
 * The figures are the same compositions the directory crops for its portraits,
 * rendered whole — the standing take and the headshot are one document, so
 * changing someone's jacket in the composer changes them here too.
 */
export function Lobby({
  people,
  parts,
  categories,
  children,
}: {
  people: LobbyPerson[]
  parts: AvatarPart[]
  categories: AvatarPartCategory[]
  children?: React.ReactNode
}) {
  const router = useRouter()
  const characters = React.useMemo<SceneCharacter[]>(
    () =>
      people.map((person) => ({
        id: person.id,
        name: person.name,
        ...(person.composition
          ? {
              figure: (
                <ComposedAvatar
                  composition={person.composition}
                  parts={parts}
                  categories={categories}
                  variant="full"
                  size={170}
                  animate="idle"
                  name={person.name}
                />
              ),
            }
          : {}),
        ...(person.status ? { status: person.status } : {}),
        idleAnimation: person.idleAnimation ?? 'bounce',
        walkSpeed: person.walkSpeed ?? paceFor(person.id),
      })),
    [people, parts, categories],
  )

  return (
    <CharacterScene
      characters={characters}
      height={360}
      baseCharacterSize={170}
      contentZone={{ minX: 0, maxX: 100, minY: 0, maxY: 44 }}
      config={{ spawnMinY: 62 }}
      onSelect={(id) => router.push(`/organization/agents?person=${id}`, { scroll: false })}
    >
      {children}
    </CharacterScene>
  )
}
