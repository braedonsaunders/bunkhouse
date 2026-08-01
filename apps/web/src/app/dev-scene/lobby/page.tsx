'use client'

import * as React from 'react'
import { useSearchParams } from 'next/navigation'
import { Lobby, type LobbyDepartment } from '../../../components/lobby'
import { toLightBackdrop } from '../../../lib/scene-recolour'

/**
 * The floor's department picker, with sample places and no sign-in.
 *
 * The reason this exists: switching departments is a wipe, and a wipe is a
 * second of motion that no screenshot and no unit test can judge. The real
 * floor is behind an auth wall and needs a seeded company, so the wipe between
 * a department's own drawing and a built-in room shipped without ever being
 * watched — and it was not a wipe at all, it was a hard cut, because a drawn
 * department bypassed the component that owns the animation.
 *
 * Two drawn places sit next to two built-in ones on purpose: every pairing
 * (drawn→drawn, drawn→built-in, built-in→drawn, built-in→built-in) has to
 * sweep, and has to sweep from the side the button sits on.
 */
const WORKSHOP = `<svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg"><rect width="1600" height="468" fill="#111c30"/><rect y="468" width="1600" height="432" fill="#0b1220"/><rect x="1000" y="330" width="120" height="90" fill="#8fc7f0"/><rect x="300" y="300" width="380" height="168" fill="#1a2740"/><rect x="700" y="400" width="60" height="24" fill="#f5a623"/></svg>`

/** A second drawing, plainly a different room at a glance. */
const GREENHOUSE = `<svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg"><rect width="1600" height="468" fill="#123023"/><rect y="468" width="1600" height="432" fill="#0a1b12"/><circle cx="1240" cy="220" r="90" fill="#6fd39b"/><rect x="240" y="360" width="300" height="108" fill="#1e4a34"/><rect x="820" y="420" width="80" height="48" fill="#f5a623"/></svg>`

const PLACES: LobbyDepartment[] = [
  { id: '1', name: 'The floor', slug: 'floor', sceneKind: 'office', backdropSvg: null, backdropSvgLight: null },
  {
    id: '2',
    name: 'Workshop',
    slug: 'workshop',
    sceneKind: null,
    backdropSvg: WORKSHOP,
    backdropSvgLight: toLightBackdrop(WORKSHOP),
  },
  {
    id: '3',
    name: 'Greenhouse',
    slug: 'greenhouse',
    sceneKind: null,
    backdropSvg: GREENHOUSE,
    backdropSvgLight: toLightBackdrop(GREENHOUSE),
  },
  { id: '4', name: 'Warehouse', slug: 'warehouse', sceneKind: 'warehouse', backdropSvg: null, backdropSvgLight: null },
  { id: '5', name: 'Rooftop', slug: 'rooftop', sceneKind: 'rooftop', backdropSvg: null, backdropSvgLight: null },
]

function LobbyProbe() {
  // The picker pushes `?dept=`, exactly as it does on the home screen, and this
  // page reads it back — the real page does the same thing through its server
  // render. Reading the query rather than holding local state is the point: the
  // wipe has to survive a navigation, not just a `setState`.
  const slug = useSearchParams().get('dept') ?? PLACES[0]!.slug
  return (
    <main className="h-dvh bg-canvas">
      <Lobby people={[]} parts={[]} categories={[]} selectBasePath="/dev-scene/lobby" departments={PLACES} departmentSlug={slug} />
    </main>
  )
}

export default function DevLobby() {
  // `useSearchParams` opts a page into client rendering, and Next wants the
  // boundary spelled out.
  return (
    <React.Suspense fallback={null}>
      <LobbyProbe />
    </React.Suspense>
  )
}
