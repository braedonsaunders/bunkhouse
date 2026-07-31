'use client'

import { DepartmentsSettings } from '../../../components/departments-settings'

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

const ROWS = [
  { id: '1', name: 'The floor', sceneKind: 'office', backdropSvg: null, backdropPrompt: null, headcount: 4 },
  { id: '2', name: 'Workshop', sceneKind: null, backdropSvg: DRAWN, backdropPrompt: 'a warm workshop with a pegboard of tools', headcount: 2 },
  { id: '3', name: 'Executive', sceneKind: 'executive', backdropSvg: null, backdropPrompt: null, headcount: 1 },
  { id: '4', name: 'Warehouse', sceneKind: 'warehouse', backdropSvg: null, backdropPrompt: null, headcount: 0 },
  { id: '5', name: 'Server room', sceneKind: 'serverroom', backdropSvg: null, backdropPrompt: null, headcount: 0 },
  { id: '6', name: 'Break room', sceneKind: 'breakroom', backdropSvg: null, backdropPrompt: null, headcount: 0 },
]

const KINDS = [
  { value: 'office', label: 'Office' },
  { value: 'executive', label: 'Executive' },
  { value: 'warehouse', label: 'Warehouse' },
  { value: 'serverroom', label: 'Server room' },
  { value: 'breakroom', label: 'Break room' },
  { value: 'rooftop', label: 'Rooftop' },
]

export default function DevDepartments() {
  return (
    <main className="min-h-dvh bg-canvas p-8">
      <h1 className="mb-6 text-lg font-semibold text-fg">Departments</h1>
      <div style={{ maxWidth: 1000 }}>
        <DepartmentsSettings departments={ROWS} deskless={2} wander={false} sceneKinds={KINDS} />
      </div>
    </main>
  )
}
