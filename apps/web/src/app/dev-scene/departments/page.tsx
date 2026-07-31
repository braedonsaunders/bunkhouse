'use client'

import * as React from 'react'
import { DepartmentsSettings, type DepartmentRow } from '../../../components/departments-settings'
import { toLightBackdrop } from '../../../lib/scene-recolour'

/**
 * A stand-in backdrop, not a real one — this page is about the LAYOUT, and a
 * ten-kilobyte drawing inlined here would ship to production for no reason.
 */

/**
 * The departments screen against sample data, with no database and no sign-in.
 *
 * The reason this exists: the real screen is behind an auth wall, so the first
 * version of it shipped having never been looked at — and it was six stacked
 * cards of inline forms, which is exactly what you get when nobody sees the
 * thing they built.
 */
const DRAWN = `<svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg"><rect width="1600" height="468" fill="#111c30"/><rect y="468" width="1600" height="432" fill="#0b1220"/><rect x="1000" y="330" width="120" height="90" fill="#8fc7f0"/><rect x="300" y="300" width="380" height="168" fill="#1a2740"/><rect x="700" y="400" width="60" height="24" fill="#f5a623"/></svg>`

// Derived exactly as the real one is, so this page shows the actual recolour
// rather than a hand-picked pair that flatters it.
const DRAWN_LIGHT = toLightBackdrop(DRAWN)

const ROWS: DepartmentRow[] = [
  { id: '1', name: 'The floor', sceneKind: 'office', backdropSvg: null, backdropSvgLight: null, backdropPrompt: null, headcount: 4 },
  { id: '2', name: 'Workshop', sceneKind: null, backdropSvg: DRAWN, backdropSvgLight: DRAWN_LIGHT, backdropPrompt: 'a warm workshop with a pegboard of tools', headcount: 2 },
  { id: '3', name: 'Executive', sceneKind: 'executive', backdropSvg: null, backdropSvgLight: null, backdropPrompt: null, headcount: 1 },
  { id: '4', name: 'Warehouse', sceneKind: 'warehouse', backdropSvg: null, backdropSvgLight: null, backdropPrompt: null, headcount: 0 },
  { id: '5', name: 'Server room', sceneKind: 'serverroom', backdropSvg: null, backdropSvgLight: null, backdropPrompt: null, headcount: 0 },
  { id: '6', name: 'Break room', sceneKind: 'breakroom', backdropSvg: null, backdropSvgLight: null, backdropPrompt: null, headcount: 0 },
]

const KINDS = [
  { value: 'office', label: 'Office' },
  { value: 'executive', label: 'Executive' },
  { value: 'warehouse', label: 'Warehouse' },
  { value: 'serverroom', label: 'Server room' },
  { value: 'breakroom', label: 'Break room' },
  { value: 'rooftop', label: 'Rooftop' },
]

/** A different drawing, to stand in for one the model just returned. */
const REDRAWN = DRAWN.replace('#8fc7f0', '#f5a623').replace('#1a2740', '#33455f')

export default function DevDepartments() {
  // What the server component would hand down. Held in state so the button
  // below can play the part revalidation plays in the real app.
  const [rows, setRows] = React.useState(ROWS)

  return (
    <main className="min-h-dvh bg-canvas p-8">
      <h1 className="mb-6 text-lg font-semibold text-fg">Departments</h1>
      {/* Both variants side by side. The floor only ever shows one, so this is
          the only place the pair can be judged as a pair. */}
      <div className="mb-8 grid max-w-3xl grid-cols-2 gap-4">
        {([['Dim', DRAWN], ['Bright', DRAWN_LIGHT]] as const).map(([label, svg]) => (
          <div key={label}>
            <p className="mb-1 text-xs text-fg-subtle">{label}</p>
            <div
              className="aspect-[16/9] overflow-hidden rounded-lg border border-border [&>svg]:h-full [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        ))}
      </div>
      {/* Saving a backdrop used to write the new drawing and then snap the
          open drawer back to the old one. Two reasons: the drawer held a copy
          of the row taken when it was clicked, and the actions revalidated a
          route that no longer existed. Open Workshop, then press this — it
          stands in for the data arriving, and the drawer has to follow it. */}
      <button
        type="button"
        className="mb-4 rounded-lg border border-border px-3 py-1.5 text-sm text-fg"
        onClick={() =>
          setRows((current) =>
            current.map((row) =>
              row.id === '2'
                ? { ...row, backdropSvg: REDRAWN, backdropSvgLight: toLightBackdrop(REDRAWN) }
                : row,
            ),
          )
        }
      >
        Stand in for a save landing
      </button>
      <div style={{ maxWidth: 1000 }}>
        <DepartmentsSettings departments={rows} deskless={2} wander={false} sceneKinds={KINDS} />
      </div>
    </main>
  )
}
