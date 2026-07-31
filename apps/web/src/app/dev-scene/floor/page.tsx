'use client'

import * as React from 'react'
import { CharacterScene, type SceneCharacter } from '@appkit/scene'
import { bunkhouseSceneGround, BunkhouseSceneArt } from '../../../components/scene-art'

/**
 * The floor, with a button that remounts it.
 *
 * Reproduces the bug this page exists for: opening and closing a record flyout
 * re-renders the page, every character unmounted, and each remount handed them
 * a fresh random spot — so the whole cast teleported the moment you closed a
 * panel. Toggling below does the same thing far more violently than the real
 * navigation does, so if positions survive this they survive that.
 */
const CAST: SceneCharacter[] = [
  { id: 'a', name: 'Aria', title: 'Researcher', status: { label: 'reading', tone: 'busy', activity: 'reading' } },
  { id: 'b', name: 'Bill', title: 'Customer Service', status: { label: 'on a call', tone: 'active', activity: 'talking' } },
  { id: 'c', name: 'Dana', title: 'Office Admin', status: { label: 'needs you', tone: 'waiting', activity: 'waiting' } },
  { id: 'd', name: 'Jimmy', title: 'Customer Service', status: { label: 'free', tone: 'idle', activity: 'idle' } },
]

export default function FloorProbe() {
  const [mounted, setMounted] = React.useState(true)
  const [nonce, setNonce] = React.useState(0)
  return (
    <main className="min-h-dvh bg-canvas p-6">
      <div className="mb-4 flex gap-3">
        <button
          type="button"
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-fg"
          onClick={() => setMounted((v) => !v)}
        >
          {mounted ? 'Unmount the floor' : 'Mount the floor'}
        </button>
        <button
          type="button"
          className="rounded-md bg-elevated px-3 py-1.5 text-sm text-fg ring-1 ring-border"
          onClick={() => setNonce((n) => n + 1)}
        >
          Re-render ({nonce})
        </button>
      </div>
      {/* Explicit pixels: this page sits inside a flex frame that collapses to
          zero width, and a stage with no width correctly draws nobody. */}
      {mounted ? (
        <div style={{ width: 900, height: 420 }}>
          <CharacterScene
            characters={CAST}
            ground={bunkhouseSceneGround('office')}
            art={<BunkhouseSceneArt kind="office" isDark />}
          />
        </div>
      ) : (
        <div className="flex items-center justify-center text-fg-muted" style={{ width: 900, height: 420 }}>
          floor unmounted
        </div>
      )}
    </main>
  )
}
