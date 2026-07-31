/**
 * The built-in rooms, as plain data.
 *
 * Deliberately NOT in `scene-art.tsx`, which is a `'use client'` module. A
 * server component importing a value from a client module does not get the
 * value — it gets a client-reference proxy, so `SCENE_KINDS.map is not a
 * function` at runtime while typechecking and building perfectly happily.
 * That is exactly what took the settings page down.
 *
 * Constants shared across the boundary have to live on the server side of it.
 * The artwork keeps its directive; the names of the rooms do not need one.
 */
export type SceneKind = 'office' | 'executive' | 'warehouse' | 'serverroom' | 'breakroom' | 'rooftop'

export const SCENE_KINDS = ['office', 'executive', 'warehouse', 'serverroom', 'breakroom', 'rooftop'] as const

export const SCENE_LABELS: Record<SceneKind, string> = {
  office: 'Office',
  executive: 'Executive',
  warehouse: 'Warehouse',
  serverroom: 'Server room',
  breakroom: 'Break room',
  rooftop: 'Rooftop',
}
