'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useTheme } from '@appkit/ui'
import { CharacterScene, type SceneCharacter } from '@appkit/scene'
import type { AvatarComposition, AvatarPart, AvatarPartCategory } from '@appkit/avatars/composition'
import { SeatedFigure } from './seated-figure'
import {
  BunkhouseSceneArt,
  SCENE_KINDS,
  SCENE_LABELS,
  bunkhouseSceneGround,
  type SceneKind,
} from './scene-art'

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

/** A place in the company, as the floor needs it. */
export type LobbyDepartment = {
  id: string
  name: string
  slug: string
  /** A built-in room, or null when this department has its own artwork. */
  sceneKind: SceneKind | null
  /** Sanitised SVG for the dark theme — see lib/scene-svg.ts. Never raw model output. */
  backdropSvg: string | null
  /** The same room drawn for the light theme. */
  backdropSvgLight: string | null
}

export type LobbyPerson = {
  id: string
  name: string
  /** True when they are somewhere that is not their own department today. */
  visiting?: boolean
  /**
   * Their one figure. Required: the floor draws people, and an agent with no
   * artwork would walk it as an initials disc — a placeholder in the one screen
   * that is supposed to look like a room. Whoever fills the floor leaves the
   * undrawn out (see app/page.tsx).
   */
  composition: AvatarComposition
  /** Their role, shown beside the name on hover. */
  title?: string
  /** What they are doing, as a pill anyone can read without hovering. */
  status?: {
    label: string
    tone: 'active' | 'busy' | 'idle' | 'waiting' | 'trouble'
    activity?: 'working' | 'reading' | 'searching' | 'talking' | 'writing' | 'waiting' | 'idle'
  }
  /** Their own working note, drawn as a bubble above them while they work. */
  speech?: { text: string; kind?: 'say' | 'think' }
  idleAnimation?: 'bounce' | 'sway' | 'still' | 'dance'
  walkSpeed?: number
}

const SCENE_STORAGE_KEY = 'bunkhouse.lobby.scene'
const SCENE_CHANGE_EVENT = 'bunkhouse.lobby.scene-change'

function readStoredScene(): SceneKind {
  const stored = window.localStorage.getItem(SCENE_STORAGE_KEY)
  return stored && (SCENE_KINDS as readonly string[]).includes(stored) ? (stored as SceneKind) : 'office'
}

function subscribeToScene(onChange: () => void): () => void {
  window.addEventListener(SCENE_CHANGE_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(SCENE_CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

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
  selectBasePath = '/organization',
  departments,
  departmentSlug,
}: {
  people: LobbyPerson[]
  parts: AvatarPart[]
  categories: AvatarPartCategory[]
  /** Widgets floated over the scene — KPI tiles, the run feed, actions. */
  children?: React.ReactNode
  /**
   * Where a clicked figure opens their record. The home screen passes '/' so
   * the flyout opens in place, over the floor, with no page change beneath it.
   */
  selectBasePath?: string
  /**
   * The company's places. Empty falls back to the old wallpaper behaviour, so a
   * deployment that has not migrated still gets a floor.
   */
  departments?: LobbyDepartment[]
  /** Which one is being looked at; the page owns it so it survives navigation. */
  departmentSlug?: string
}) {
  const router = useRouter()
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  // The stage is a personal, cosmetic preference — it lives in the browser,
  // like a wallpaper, and comes back on the next visit. Read through a store
  // subscription so the server render (no localStorage) hydrates cleanly.
  const scene = React.useSyncExternalStore(subscribeToScene, readStoredScene, () => 'office' as SceneKind)
  const places = departments ?? []
  const here = places.find((d) => d.slug === departmentSlug) ?? places[0] ?? null
  // Two drawings per room, one per theme: the palette is baked into the shapes,
  // so recolouring is not an option and the floor picks the one that matches.
  const backdrop = here ? (isDark ? here.backdropSvg : (here.backdropSvgLight ?? here.backdropSvg)) : null
  // A department drawn from its own artwork still needs a floor to walk on, so
  // it borrows the office ground until somebody says otherwise.
  const sceneKind: SceneKind = here ? (here.sceneKind ?? 'office') : scene
  const pickScene = (kind: SceneKind) => {
    window.localStorage.setItem(SCENE_STORAGE_KEY, kind)
    window.dispatchEvent(new Event(SCENE_CHANGE_EVENT))
  }

  const characters = React.useMemo<SceneCharacter[]>(
    () =>
      people.map((person) => ({
        id: person.id,
        name: person.name,
        figure: (
          <SeatedFigure
            composition={person.composition}
            parts={parts}
            categories={categories}
            size={170}
            name={person.name}
          />
        ),
        ...(person.title ? { title: person.title } : {}),
        ...(person.status ? { status: person.status } : {}),
        ...(person.speech ? { speech: person.speech } : {}),
        idleAnimation: person.idleAnimation ?? 'bounce',
        walkSpeed: person.walkSpeed ?? paceFor(person.id),
      })),
    [people, parts, categories],
  )

  return (
    // `isolate`: the widgets (z-[92]) and picker (z-[95]) layer against the
    // scene inside this block only — never against the record drawer, which
    // portals to <body> at z-50 and must paint above the whole floor.
    <div className="isolate relative h-full min-h-0">
      <CharacterScene
        characters={characters}
        ground={bunkhouseSceneGround(sceneKind)}
        art={
          backdrop ? (
            // Sanitised on the way in — lib/scene-svg.ts strips anything that
            // can act, so what reaches here is shapes and nothing else.
            <div
              className="h-full w-full [&>svg]:h-full [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: backdrop }}
            />
          ) : (
            <BunkhouseSceneArt kind={sceneKind} isDark={isDark} />
          )
        }
        height="100%"
        baseCharacterSize={170}
        className="rounded-none border-0"
        // The only widget left over the floor is the HUD band across the top,
        // so that is the only place a walker must not stand.
        config={{ exclusionZones: [{ minX: 0, maxX: 100, minY: 0, maxY: 40 }] }}
        onSelect={(id) => router.push(`${selectBasePath}?person=${id}`, { scroll: false })}
      />
      {children ? <div className="pointer-events-none absolute inset-0 z-[92]">{children}</div> : null}
      <div className="bh-hud absolute bottom-3 left-1/2 z-[95] flex -translate-x-1/2 items-center gap-1 rounded-full p-1">
        {places.length > 0
          ? places.map((place) => (
              <button
                key={place.id}
                type="button"
                onClick={() => router.push(`${selectBasePath}?dept=${place.slug}`, { scroll: false })}
                aria-pressed={here?.id === place.id}
                title={place.name}
                className={
                  here?.id === place.id
                    ? 'rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-fg'
                    : 'rounded-full px-3 py-1 text-xs text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg'
                }
              >
                {place.name}
              </button>
            ))
          : SCENE_KINDS.map((kind) => (
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
