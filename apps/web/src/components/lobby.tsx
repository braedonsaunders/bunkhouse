'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useTheme } from '@appkit/ui'
import {
  CharacterScene,
  OFFICE_SCENE_KINDS,
  SceneArt,
  sceneGround,
  type SceneCharacter,
  type SceneKind,
} from '@appkit/scene'
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

const SCENE_LABELS: Partial<Record<SceneKind, string>> = {
  office: 'Office',
  executive: 'Executive',
  warehouse: 'Warehouse',
  serverroom: 'Server room',
  breakroom: 'Break room',
  rooftop: 'Rooftop',
}

const SCENE_STORAGE_KEY = 'bunkhouse.lobby.scene'

/**
 * The bunkhouse floor: the agents on staff at work in one of the drawn office
 * environments, day or night with the app theme. It fills the whole home
 * screen; the dashboard floats over it as widgets. Clicking a figure opens
 * their record.
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
  /** Widgets floated over the scene — KPI tiles, the run feed, actions. */
  children?: React.ReactNode
}) {
  const router = useRouter()
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  // The stage is a personal, cosmetic preference — it lives in the browser,
  // like a wallpaper, and comes back on the next visit.
  const [scene, setScene] = React.useState<SceneKind>('office')
  React.useEffect(() => {
    const stored = window.localStorage.getItem(SCENE_STORAGE_KEY)
    if (stored && (OFFICE_SCENE_KINDS as string[]).includes(stored)) setScene(stored as SceneKind)
  }, [])
  const pickScene = (kind: SceneKind) => {
    setScene(kind)
    window.localStorage.setItem(SCENE_STORAGE_KEY, kind)
  }

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
    <div className="relative h-full min-h-0">
      <CharacterScene
        characters={characters}
        ground={sceneGround(scene, isDark)}
        art={<SceneArt kind={scene} isDark={isDark} />}
        height="100%"
        baseCharacterSize={170}
        className="rounded-none border-0"
        // Keep the walkers clear of the floating widgets: the run feed on the
        // left, and give the KPI band across the top of the floor a margin.
        config={{
          exclusionZones: [
            { minX: 0, maxX: 30, minY: 44, maxY: 100 },
            { minX: 0, maxX: 100, minY: 0, maxY: 40 },
          ],
        }}
        onSelect={(id) => router.push(`/organization/agents?person=${id}`, { scroll: false })}
      />
      {children ? <div className="pointer-events-none absolute inset-0 z-[92]">{children}</div> : null}
      <div className="absolute bottom-3 left-1/2 z-[95] flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-surface/80 p-1 shadow-sm backdrop-blur">
        {OFFICE_SCENE_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => pickScene(kind)}
            aria-pressed={scene === kind}
            title={SCENE_LABELS[kind]}
            className={
              scene === kind
                ? 'rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-fg'
                : 'rounded-full px-3 py-1 text-xs text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg'
            }
          >
            {SCENE_LABELS[kind]}
          </button>
        ))}
      </div>
    </div>
  )
}
