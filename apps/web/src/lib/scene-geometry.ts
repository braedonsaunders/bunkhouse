/**
 * Reading the shapes back out of a drawing.
 *
 * Two things need to know where a generated backdrop's shapes actually are:
 * the scorer, which judges whether a drawing obeys the brief, and the lighting,
 * which puts a pool on the floor under whatever is glowing. Both want the same
 * crude answer — a box and a fill per shape — so it lives here once.
 *
 * Deliberately approximate, and it has to be said plainly: this is a regex over
 * markup, not an SVG engine. `transform` is ignored, `path` is reduced to the
 * span of the numbers in its `d`, and a shape inside a `<g transform>` is
 * reported where it was typed rather than where it lands. That is fine for what
 * it is for — nudging a model toward a better composition, and placing a soft
 * gradient — and would not be fine for anything that had to be exact.
 */

export type ShapeBox = {
  tag: string
  /** Bounds in the drawing's own units. */
  x: number
  y: number
  width: number
  height: number
  /** Lower-cased `fill`, or null when the shape inherits or has none. */
  fill: string | null
  /** Motion classes carried by the shape or its group. */
  classes: string[]
}

const SHAPE_TAGS = ['rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline', 'path'] as const

/** Every number in a string, in order. */
function numbers(source: string): number[] {
  return (source.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []).map(Number).filter((n) => Number.isFinite(n))
}

function attr(tag: string, name: string): string | null {
  const found = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)
  return found ? found[1]! : null
}

function num(tag: string, name: string, fallback = 0): number {
  const raw = attr(tag, name)
  if (raw === null) return fallback
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Bounds of a run of `x,y` pairs — `points`, or the numbers in a path. */
function spanOf(values: number[]): { x: number; y: number; width: number; height: number } | null {
  if (values.length < 2) return null
  const xs: number[] = []
  const ys: number[] = []
  for (let index = 0; index + 1 < values.length; index += 2) {
    xs.push(values[index]!)
    ys.push(values[index + 1]!)
  }
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY }
}

/**
 * Every drawable shape in an SVG, with its box.
 *
 * Groups are tracked only for their `class`, so a `<g class="bhs-glow">` marks
 * everything inside it as lit rather than being missed entirely — which is how
 * a model usually writes a bank of screens.
 */
export function readShapes(svg: string): ShapeBox[] {
  const shapes: ShapeBox[] = []
  const groupClasses: string[][] = []
  const tagPattern = /<\s*(\/?)([a-zA-Z][\w:-]*)\b([^>]*)>/g
  let found: RegExpExecArray | null

  while ((found = tagPattern.exec(svg)) !== null) {
    const closing = found[1] === '/'
    const tag = found[2]!.toLowerCase()
    const whole = found[0]!
    const selfClosing = /\/\s*>$/.test(whole)

    if (tag === 'g') {
      if (closing) groupClasses.pop()
      else if (!selfClosing) groupClasses.push((attr(whole, 'class') ?? '').split(/\s+/).filter(Boolean))
      continue
    }
    if (closing || !(SHAPE_TAGS as readonly string[]).includes(tag)) continue

    const inherited = groupClasses.flat()
    const own = (attr(whole, 'class') ?? '').split(/\s+/).filter(Boolean)
    const fill = (attr(whole, 'fill') ?? attr(whole, 'stroke'))?.trim().toLowerCase() ?? null

    let box: { x: number; y: number; width: number; height: number } | null = null
    switch (tag) {
      case 'rect':
        box = { x: num(whole, 'x'), y: num(whole, 'y'), width: num(whole, 'width'), height: num(whole, 'height') }
        break
      case 'circle': {
        const r = num(whole, 'r')
        box = { x: num(whole, 'cx') - r, y: num(whole, 'cy') - r, width: r * 2, height: r * 2 }
        break
      }
      case 'ellipse': {
        const rx = num(whole, 'rx')
        const ry = num(whole, 'ry')
        box = { x: num(whole, 'cx') - rx, y: num(whole, 'cy') - ry, width: rx * 2, height: ry * 2 }
        break
      }
      case 'line': {
        const x1 = num(whole, 'x1')
        const x2 = num(whole, 'x2')
        const y1 = num(whole, 'y1')
        const y2 = num(whole, 'y2')
        box = { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
        break
      }
      case 'polygon':
      case 'polyline':
        box = spanOf(numbers(attr(whole, 'points') ?? ''))
        break
      case 'path':
        // Relative commands make this a rough span rather than a bounding box.
        // A shape drawn entirely in relative moves reads as small and near the
        // origin; the scorer treats every measurement as a hint for that reason.
        box = spanOf(numbers(attr(whole, 'd') ?? ''))
        break
    }
    if (!box) continue
    shapes.push({ tag, ...box, fill, classes: [...inherited, ...own] })
  }
  return shapes
}
