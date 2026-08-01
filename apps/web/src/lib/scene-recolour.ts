import { DEFAULT_PALETTE, type BackdropPalette } from './scene-palette'

/* -- the same room, in the other palette ----------------------------------- */

/**
 * The light version is DERIVED from the dark one, not drawn separately.
 *
 * Asking the model twice gives you two different rooms — a workshop with the
 * roller door on the left in one theme and on the right in the other — so
 * switching theme would rearrange the furniture rather than turn the lights on.
 * Recolouring the markup keeps every shape exactly where it was, which is the
 * only thing that makes a theme switch read as the same place.
 *
 * It is also one model call instead of two, and instant.
 */

const HEX = /#([0-9a-f]{3}|[0-9a-f]{6})\b/gi

function parseHex(hex: string): [number, number, number] {
  const body = hex.slice(1)
  const full = body.length === 3 ? body.replace(/./g, (c) => c + c) : body
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ]
}

function toHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)))
  return `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, '0')).join('')}`
}

/**
 * Flip a colour's lightness, keep its hue.
 *
 * The fallback for anything the model used that was not on the palette — and
 * something always is. A near-black stray becomes near-white, so it keeps the
 * same relationship to its background instead of staying a dark smudge on a
 * pale wall. Saturation is pulled in a little because a hue that reads as
 * moody at 12% lightness reads as garish at 88%.
 */
function flipLightness(hex: string): string {
  const [r, g, b] = parseHex(hex).map((n) => n / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  // Not a pure inversion: mid-tones would barely move, and the point is that
  // dark structure has to become light structure.
  const flipped = 0.94 - l * 0.82
  const softened = s * 0.75
  const c = (1 - Math.abs(2 * flipped - 1)) * softened
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = flipped - c / 2
  const [r2, g2, b2] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x]
  return toHex((r2 + m) * 255, (g2 + m) * 255, (b2 + m) * 255)
}

/**
 * Dark palette hex → light palette hex, for the colours the brief asked for.
 *
 * Built per palette rather than once, because the room is no longer always
 * drawn in the same five colours: a steel shop and a copper electrical room
 * have their own ramps, and mapping one through the other's would repaint the
 * room a different material on the way into daylight.
 */
function mapping(palette: BackdropPalette): Map<string, string> {
  return new Map<string, string>([
    ...palette.dark.colours.map((from, i) => [from.toLowerCase(), palette.light.colours[i]!] as const),
    [palette.dark.lit.toLowerCase(), palette.light.lit] as const,
    [palette.dark.material.toLowerCase(), palette.light.material] as const,
    // The accent is the brand amber and works on both. Left alone deliberately.
    [palette.dark.accent.toLowerCase(), palette.light.accent] as const,
  ])
}

/**
 * The two colour words a model reaches for regardless of what the brief said.
 * Only ever replaced inside a colour attribute, so a `class="black-panel"`
 * survives untouched.
 */
const NAMED = /\b(fill|stroke|stop-color|flood-color)\s*=\s*"(white|black)"/gi
const NAMED_LIGHT: Record<string, string> = { white: '#1b2430', black: '#eef2f7' }

/**
 * The dark drawing, shape for shape, in daylight.
 *
 * The palette is the one the room was drawn in; anything it does not name
 * falls back to flipping lightness, which is what has always caught the
 * colours a model reaches for that nobody asked for.
 */
export function toLightBackdrop(svg: string, palette: BackdropPalette = DEFAULT_PALETTE): string {
  const mapped = mapping(palette)
  return svg
    .replace(HEX, (hex) => {
      const key = hex.toLowerCase()
      return mapped.get(key) ?? flipLightness(key)
    })
    .replace(NAMED, (_all, attribute: string, name: string) => `${attribute}="${NAMED_LIGHT[name.toLowerCase()]}"`)
}
