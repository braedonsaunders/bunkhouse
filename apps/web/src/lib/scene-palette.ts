/**
 * The two palettes every generated backdrop is drawn in.
 *
 * Their own module because both the brief that asks for the dim one and the
 * recolour that derives the bright one need them, and the recolour must be
 * importable without dragging in a model client — it is pure string work and
 * is tested as such.
 */
export const PALETTES = {
  dark: {
    note: 'a dim room, lit from within',
    colours: ['#0b1220', '#111c30', '#1a2740', '#24344f', '#33455f'],
    /** What glows. A flat drawing needs somewhere for the eye to land. */
    lit: '#8fc7f0',
    accent: '#f5a623',
  },
  light: {
    note: 'a bright room, daylight',
    colours: ['#eef2f7', '#e2e8f0', '#cbd5e1', '#aab7c6', '#8b9aad'],
    // NOT white. In a dim room the lit things are the brightest thing in the
    // picture; in a bright one the background already is, so a white screen
    // disappears into the wall. A mid saturated blue reads as glass with a
    // light behind it against a pale field.
    lit: '#5f9fe0',
    accent: '#f5a623',
  },
} as const

export type BackdropTheme = keyof typeof PALETTES
