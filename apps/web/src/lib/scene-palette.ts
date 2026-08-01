/**
 * What a generated room is made of.
 *
 * Every backdrop used to be drawn from one palette — five shades of the same
 * desaturated navy — because the only axis here was dark and light. That is a
 * *mode*, not an identity, so a fabrication shop and an electrical contractor's
 * office came back as the same grey box with the furniture moved: no material,
 * no warmth, nothing to say which room you were looking at. The scorer then
 * marked down any colour outside those five, so the sameness was not the model
 * being poor at drawing — it was the brief insisting on it.
 *
 * A room is now drawn in the colours it is actually built from. Steel is cold
 * and green-grey with rust on it; an electrical space is warm grey with copper;
 * a break room is timber and sage. The ramp inside each palette keeps the same
 * shape — five values from near-black to mid — so composition, contrast and the
 * light/dark derivation all behave exactly as before. Only the hue moves.
 *
 * Eleven colours, because eight was not enough to build a room out of. Six
 * structural values rather than five, so a drawing can describe its own joins
 * and edges instead of stacking flat blocks; two lights rather than one, so the
 * arc and the indicator lamp are not equally bright; and two materials rather
 * than one, because a workshop is rust AND brass, and an electrical room is
 * copper AND insulation green. That second material is where most of a room's
 * colour variety comes from.
 *
 * Restraint is still the discipline — this sits behind moving characters and
 * must never compete with them — but restraint is about where the colour goes,
 * not how little of it there is. The floor stays calm and the walls stay
 * structural; the colour lives in the gear.
 */

/** One half of a palette: how the room reads in a given light. */
export type PaletteTones = {
  /**
   * Six structural values, near-black to mid. Walls, floor, furniture.
   *
   * Six rather than five because the sixth is the one that draws an edge: a
   * panel seam, the lit side of a bracket, the top of a bench against the wall
   * behind it. Five values can describe a room's masses but not its joins, and
   * a room without joins is a set of flat blocks however many of them there are.
   */
  colours: readonly string[]
  /** What glows. A flat drawing needs somewhere for the eye to land. */
  lit: string
  /**
   * The hottest light in the room, for the two or three sources that are
   * genuinely fierce — an arc, an LED seen straight on, a screen at full
   * brightness. `lit` alone gives every light the same intensity, which reads
   * as luminous wallpaper rather than as lights.
   */
  hot: string
  /** The brand accent, for one or two small things and nothing else. */
  accent: string
  /**
   * The room's own material, for the few objects genuinely made of it. This is
   * what stops one room looking like every other room, and it is a single
   * colour rather than a free hand because two of these in a drawing is a
   * workshop and five is a toy shop.
   */
  material: string
  /**
   * The room's second material, and where most of its colour variety comes
   * from — the brass beside the rust, the insulation green beside the copper,
   * the blue strapping on the yellow pallets. One material makes a room
   * identifiable; two make it look like somewhere people actually work.
   */
  material2: string
}

export type BackdropPalette = {
  slug: string
  /** What the room is built from, in the words the brief will use. */
  materials: string
  /** Words in a room's name or description that mean "this one". */
  cues: readonly string[]
  dark: PaletteTones
  light: PaletteTones
}

/** The brand amber. On every palette, and the same in both lights. */
const ACCENT = '#f5a623'

/**
 * Offices, admin, meeting rooms — anywhere the material is just "building".
 * The original palette, kept as the default, so a room that matches nothing in
 * particular looks exactly as it did before any of this.
 */
const SLATE: BackdropPalette = {
  slug: 'slate',
  materials: 'painted plaster, carpet, laminate desks and powder-coated steel',
  cues: ['office', 'admin', 'meeting', 'boardroom', 'reception', 'desk', 'executive', 'finance', 'accounts'],
  dark: {
    colours: ['#0b1220', '#111c30', '#1a2740', '#24344f', '#33455f', '#47597a'],
    lit: '#8fc7f0',
    accent: ACCENT,
    material: '#5b7fa6',
    hot: '#d7ecff',
    material2: '#a2794f',
  },
  light: {
    colours: ['#eef2f7', '#e2e8f0', '#cbd5e1', '#aab7c6', '#8b9aad', '#6f8095'],
    // NOT white. In a dim room the lit things are the brightest thing in the
    // picture; in a bright one the background already is, so a white screen
    // disappears into the wall. A mid saturated blue reads as glass with a
    // light behind it against a pale field.
    lit: '#5f9fe0',
    accent: ACCENT,
    material: '#7d9cc0',
    hot: '#2f7fc9',
    material2: '#b08a5c',
  },
}

/** Welding bays, machine shops, fabrication: cold steel, and rust on it. */
const STEEL: BackdropPalette = {
  slug: 'steel',
  materials: 'bare and galvanised steel, concrete, weld spatter and rust',
  cues: ['shop', 'fabrication', 'fab', 'weld', 'machine', 'mechanical', 'millwright', 'metal', 'press', 'plant'],
  dark: {
    colours: ['#0d1214', '#151d20', '#202b30', '#2c3a40', '#3d4f57', '#4f6670'],
    // A welding arc is the brightest thing in a shop, and it is blue-white.
    lit: '#a9dcf2',
    accent: ACCENT,
    material: '#c0682f',
    hot: '#e8f7ff',
    material2: '#c9a227',
  },
  light: {
    colours: ['#eef1f2', '#e0e6e8', '#c7d1d5', '#a3b1b7', '#83949c', '#69797f'],
    lit: '#4f97c9',
    accent: ACCENT,
    material: '#c8703a',
    hot: '#1f6f9c',
    material2: '#b39420',
  },
}

/** Electrical rooms and contractor benches: grey gear, copper everywhere. */
const COPPER: BackdropPalette = {
  slug: 'copper',
  materials: 'grey enclosures and conduit, copper busbar and cable, moulded plastic',
  cues: ['electric', 'electrical', 'panel', 'switchgear', 'wiring', 'controls', 'instrument', 'power'],
  dark: {
    colours: ['#101112', '#191b1d', '#262a2d', '#353b40', '#485056', '#5c666d'],
    lit: '#8fd0f0',
    accent: ACCENT,
    material: '#d0863d',
    hot: '#e6f6ff',
    material2: '#3f8f7a',
  },
  light: {
    colours: ['#f1f2f3', '#e3e5e7', '#cbcfd3', '#a8aeb4', '#878e95', '#6d757c'],
    lit: '#4f97c9',
    accent: ACCENT,
    material: '#b87a3c',
    hot: '#1f6f9c',
    material2: '#3d8a76',
  },
}

/** Break rooms, kitchens, lounges: timber, and something growing in the corner. */
const TIMBER: BackdropPalette = {
  slug: 'timber',
  materials: 'warm timber, soft furnishing, painted brick and a plant or two',
  cues: ['break', 'kitchen', 'lounge', 'canteen', 'cafe', 'rest', 'social'],
  dark: {
    colours: ['#12100d', '#1c1813', '#2a241b', '#3a3226', '#4d4334', '#63563f'],
    // Warm, because the light in a room like this comes from lamps.
    lit: '#ffd9a0',
    accent: ACCENT,
    material: '#7a8b5c',
    hot: '#fff0d0',
    material2: '#a8563f',
  },
  light: {
    colours: ['#f7f3ec', '#ece5da', '#d9cdbb', '#bfae96', '#9c8a70', '#7d6b53'],
    lit: '#e0a95f',
    accent: ACCENT,
    material: '#8b9c6d',
    hot: '#c98a3d',
    material2: '#b06a50',
  },
}

/** Server rooms and IT: cold aisles, indicator lights, everything humming. */
const CYAN: BackdropPalette = {
  slug: 'cyan',
  materials: 'black racks, perforated steel, fibre and a great many indicator lights',
  cues: ['server', 'data', 'it', 'network', 'comms', 'rack', 'infrastructure'],
  dark: {
    colours: ['#081214', '#0e1c20', '#16292f', '#1f3a42', '#2b4f59', '#38646f'],
    lit: '#7fe3e8',
    accent: ACCENT,
    material: '#3fa88f',
    hot: '#d6ffff',
    material2: '#c25b7a',
  },
  light: {
    colours: ['#ecf4f5', '#dcebec', '#c2dcdf', '#9dc3c8', '#7aa4aa', '#5d868c'],
    lit: '#3fa0a8',
    accent: ACCENT,
    material: '#4f9f8a',
    hot: '#1f7d85',
    material2: '#b0546f',
  },
}

/** Warehouses, stores, yards: pallets, racking and painted floor markings. */
const SAND: BackdropPalette = {
  slug: 'sand',
  materials: 'plywood and pallets, painted floor markings, galvanised racking',
  cues: ['warehouse', 'store', 'storage', 'stock', 'yard', 'shipping', 'receiving', 'logistics', 'parts'],
  dark: {
    colours: ['#12110c', '#1c1a13', '#2a271c', '#3a3626', '#4e4833', '#645c41'],
    lit: '#ffe0a3',
    accent: ACCENT,
    material: '#c9a227',
    hot: '#fff3cf',
    material2: '#4f7fa8',
  },
  light: {
    colours: ['#f7f4ea', '#ece7d6', '#d9d1b8', '#bfb492', '#9c9070', '#7d7255'],
    lit: '#dfae52',
    accent: ACCENT,
    material: '#b39420',
    hot: '#c08f2f',
    material2: '#4a76a0',
  },
}

export const BACKDROP_PALETTES = [SLATE, STEEL, COPPER, TIMBER, CYAN, SAND] as const

/** Where a room lands when nothing about it says otherwise. */
export const DEFAULT_PALETTE = SLATE

/**
 * Which palette a room is drawn in, read off what the operator called it.
 *
 * Deliberately a keyword match rather than a model call: it runs before the
 * three candidates are raced, it has to give the same answer every time so a
 * redraw of the same room stays the same colour, and "shop means steel" is not
 * a judgement that needs a language model. The longest matching cue wins, so a
 * "server room" is racks rather than whatever "room" might otherwise suggest.
 */
export function paletteFor(text: string): BackdropPalette {
  const haystack = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `
  let best: { palette: BackdropPalette; cue: number } | null = null
  for (const palette of BACKDROP_PALETTES) {
    for (const cue of palette.cues) {
      if (!haystack.includes(` ${cue} `)) continue
      if (!best || cue.length > best.cue) best = { palette, cue: cue.length }
    }
  }
  return best?.palette ?? DEFAULT_PALETTE
}

export type BackdropTheme = 'dark' | 'light'
