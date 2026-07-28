'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { CharacterScene, type SceneCharacter } from '@appkit/scene'

export type LobbyPerson = {
  id: string
  name: string
  imageUrl?: string
  status?: { label: string; tone: 'active' | 'busy' | 'idle' }
  idleAnimation?: 'bounce' | 'sway' | 'still' | 'dance'
  walkSpeed?: number
}

/**
 * The bunkhouse floor: everyone who works here, milling about. Clicking a
 * figure opens their record. The overlay content sits in a zone the walkers
 * keep clear of.
 */
export function Lobby({ people, children }: { people: LobbyPerson[]; children?: React.ReactNode }) {
  const router = useRouter()
  const characters = React.useMemo<SceneCharacter[]>(
    () =>
      people.map((person) => ({
        id: person.id,
        name: person.name,
        ...(person.imageUrl ? { imageUrl: person.imageUrl } : {}),
        ...(person.status ? { status: person.status } : {}),
        idleAnimation: person.idleAnimation ?? 'bounce',
        walkSpeed: person.walkSpeed ?? 0.8 + Math.random() * 0.5,
      })),
    [people],
  )

  return (
    <CharacterScene
      characters={characters}
      height={360}
      baseCharacterSize={170}
      contentZone={{ minX: 0, maxX: 100, minY: 0, maxY: 44 }}
      config={{ spawnMinY: 62 }}
      onSelect={(id) => router.push(`/people?person=${id}`, { scroll: false })}
    >
      {children}
    </CharacterScene>
  )
}
