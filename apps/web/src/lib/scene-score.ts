/**
 * Marking a drawing against the brief.
 *
 * The brief asks for 90 to 160 shapes, three depth layers, a calm floor, a
 * handful of lit shapes and a palette. Until this existed, the only thing
 * actually checked was that at least six shapes came back — every other rule
 * was a polite request, and a model that ignored half of them produced a
 * drawing that shipped looking thin next to the hand-drawn rooms.
 *
 * So the rules are measured. Three drawings are raced against each other and
 * the best one is kept; the marks it lost become the notes it is asked to fix.
 * A model is far better at "the floor is cluttered and there is nothing at the
 * edges of the frame" than at obeying a paragraph it has already read once.
 *
 * These are heuristics over approximate geometry (see scene-geometry.ts), so
 * every one of them is a nudge and none of them is a gate. Nothing here rejects
 * a drawing — the worst that happens is that a better sibling wins.
 */

import { readShapes, type ShapeBox } from './scene-geometry'
import { BACKDROP_MOTION_CLASSES, MOTION_RANGE } from './scene-motion'

/**
 * The frame every backdrop is drawn into, and where its floor starts.
 *
 * The horizon is not a free choice. The stage's own ground config puts it at
 * 52% and scales the characters by their depth against it, so a drawing whose
 * horizon disagrees makes everybody look like they are standing in the wall.
 */
export const FRAME = { width: 1600, height: 900, horizon: 468 } as const

/** What the brief asks for, as numbers. */
const WANT = {
  shapes: { min: 90, max: 160 },
  lit: { min: 3, max: 12 },
  /** Things whose base sits on the horizon — the middle depth layer. */
  standing: { min: 3 },
  /** Large shapes cropped by the left and right edges — the near layer. */
  cropped: { min: 2 },
  /** Faint lines fanning across the floor. */
  perspective: { min: 3 },
  /** Distinct fills used above the horizon — a banded wall, not a flat one. */
  wallTones: { min: 4 },
  /**
   * Shapes drawn in the room's own material. Scored because its absence is
   * precisely the failure that made every generated room look like every other
   * one: obedient to the palette, composed correctly, and completely anonymous.
   */
  material: { min: 6, max: 16 },
} as const

export type BackdropScore = {
  /** 0 to 1. Only ever compared against another drawing of the same brief. */
  total: number
  /** What it lost marks for, phrased as instructions. Empty means it obeyed. */
  notes: string[]
  parts: Record<string, number>
}

type Palette = { colours: readonly string[]; lit: string; accent: string; material: string }

/** A ramp: 0 below `min`, 1 at or above it. */
const atLeast = (value: number, min: number): number => Math.max(0, Math.min(1, value / Math.max(min, 1)))

/** Full marks inside the band, tailing off outside it. */
function within(value: number, min: number, max: number): number {
  if (value >= min && value <= max) return 1
  if (value < min) return atLeast(value, min)
  return Math.max(0, 1 - (value - max) / max)
}

const isLit = (shape: ShapeBox, palette: Palette): boolean =>
  shape.fill === palette.lit.toLowerCase() ||
  shape.fill === palette.accent.toLowerCase() ||
  shape.classes.some((name) => name === 'bhs-glow' || name === 'bhs-blink' || name === 'bhs-twinkle')

/**
 * Mark one drawing.
 *
 * Every part is 0 to 1 and they are averaged with weights, so a drawing that
 * nails the composition and misses the shape count still beats one that counted
 * to 120 and drew a flat wall.
 */
export function scoreBackdrop(svg: string, palette: Palette): BackdropScore {
  const shapes = readShapes(svg)
  const notes: string[] = []
  const { horizon, width } = FRAME

  // --- how much is drawn ---------------------------------------------------
  const count = shapes.length
  const density = within(count, WANT.shapes.min, WANT.shapes.max)
  if (count < WANT.shapes.min) {
    notes.push(
      `Only ${count} shapes — it will read as unfinished at full screen. Take it to ${WANT.shapes.min}–${WANT.shapes.max} by detailing what is already there: edges and shadows on the objects, more divisions in the wall, more contents on the shelves.`,
    )
  }

  // --- the three depth layers ---------------------------------------------
  // Middle: things whose base sits on the horizon, so they stand in the room
  // rather than float on the wall.
  const standing = shapes.filter((s) => {
    const base = s.y + s.height
    return base > horizon - 40 && base < horizon + 90 && s.height > 40
  }).length
  // Near: big shapes cut off by the left and right edges. This is the one that
  // creates depth, and the one models skip most often.
  //
  // The width ceiling matters more than it looks: without it the back wall
  // itself — one rect spanning the frame, touching both edges, taller than
  // anything — scores as a near-layer object at each edge, and the flattest
  // possible drawing gets full marks for depth.
  const nearLayer = (s: ShapeBox): boolean => s.height > 260 && s.width > 60 && s.width < 520
  const croppedLeft = shapes.some((s) => s.x <= 8 && nearLayer(s))
  const croppedRight = shapes.some((s) => s.x + s.width >= width - 8 && nearLayer(s))
  const cropped = (croppedLeft ? 1 : 0) + (croppedRight ? 1 : 0)
  const depth = (atLeast(standing, WANT.standing.min) + cropped / WANT.cropped.min) / 2
  if (standing < WANT.standing.min) {
    notes.push(
      `Almost nothing stands in the room — put at least ${WANT.standing.min} objects against the back wall with their bases ON the horizon line at y=${horizon}, not floating above it.`,
    )
  }
  if (cropped < WANT.cropped.min) {
    notes.push(
      `The near layer is missing${cropped === 1 ? ' on one side' : ''}. Add one tall object at the far left edge and one at the far right, each running off the frame — cropped by it, not tucked inside it. This is what makes the picture read as a room rather than a sticker.`,
    )
  }

  // --- the floor people walk on -------------------------------------------
  // Anything big sitting in the middle third below the horizon is something a
  // character will walk through.
  const middle = { from: width / 3, to: (width * 2) / 3 }
  const intruding = shapes.filter(
    (s) =>
      s.y > horizon + 30 &&
      s.height > 90 &&
      s.x + s.width > middle.from &&
      s.x < middle.to,
  ).length
  const calm = intruding === 0 ? 1 : Math.max(0, 1 - intruding / 4)
  if (intruding > 0) {
    notes.push(
      `${intruding} object${intruding === 1 ? ' sits' : 's sit'} in the middle of the floor where the staff walk. Clear the middle third below the horizon — move them against the back wall or off to the edges.`,
    )
  }

  // Faint horizontal or fanning lines on the floor.
  const perspective = shapes.filter(
    (s) => (s.tag === 'line' || s.tag === 'path' || s.tag === 'polyline') && s.y + s.height > horizon,
  ).length
  const receding = atLeast(perspective, WANT.perspective.min)
  if (perspective < WANT.perspective.min) {
    notes.push(
      'The floor is a flat slab. Add four to eight faint lines fanning from the horizon toward the bottom corners, barely darker than the floor itself.',
    )
  }

  // --- light ---------------------------------------------------------------
  const litShapes = shapes.filter((s) => isLit(s, palette))
  const lit = within(litShapes.length, WANT.lit.min, WANT.lit.max)
  const litBelow = litShapes.filter((s) => s.y > horizon + 60 && s.x > middle.from && s.x < middle.to).length
  if (litShapes.length < WANT.lit.min) {
    notes.push(
      `Only ${litShapes.length} lit shape${litShapes.length === 1 ? '' : 's'}. A flat drawing needs somewhere for the eye to land: give it ${WANT.lit.min}–6 small things glowing in ${palette.lit} — screens, a lamp, a doorway with light behind it — all above the horizon or at the far edges.`,
    )
  }

  // --- the wall ------------------------------------------------------------
  const wallTones = new Set(
    shapes.filter((s) => s.y + s.height <= horizon + 20 && s.fill).map((s) => s.fill!),
  ).size
  const banding = atLeast(wallTones, WANT.wallTones.min)
  if (wallTones < WANT.wallTones.min) {
    notes.push(
      'The back wall is one flat rectangle. Band it — a lower dado, a main field and a narrower ceiling strip, each a slightly different value from the palette.',
    )
  }

  // --- palette -------------------------------------------------------------
  const allowed = new Set(
    [...palette.colours, palette.lit, palette.accent, palette.material].map((c) => c.toLowerCase()),
  )
  const filled = shapes.filter((s) => s.fill && s.fill !== 'none' && !s.fill.startsWith('url('))
  const onPalette = filled.filter((s) => allowed.has(s.fill!)).length
  const obedience = filled.length === 0 ? 0 : onPalette / filled.length
  if (obedience < 0.8) {
    notes.push(
      `${Math.round((1 - obedience) * 100)}% of the fills are colours that were not in the palette. Use only ${[...palette.colours].join(', ')}, plus ${palette.lit} for what glows and ${palette.accent} for one or two accents.`,
    )
  }

  // --- motion --------------------------------------------------------------
  const moving = shapes.filter((s) => s.classes.some((name) => BACKDROP_MOTION_CLASSES.has(name))).length
  const motion = within(moving, MOTION_RANGE.min, MOTION_RANGE.max)
  if (moving < MOTION_RANGE.min) {
    notes.push(
      `Only ${moving} shape${moving === 1 ? '' : 's'} move${moving === 1 ? 's' : ''}. The room next door to this one is full of small loops — put ${MOTION_RANGE.min}–8 motion classes on things that would plausibly move.`,
    )
  }

  // --- material ------------------------------------------------------------
  // What the room is built from, and the only thing distinguishing a steel
  // shop from an electrical room once both have obeyed the same composition.
  const materialShapes = shapes.filter((s) => s.fill === palette.material.toLowerCase()).length
  const material = within(materialShapes, WANT.material.min, WANT.material.max)
  if (materialShapes < WANT.material.min) {
    notes.push(
      `Only ${materialShapes} shape${materialShapes === 1 ? '' : 's'} in ${palette.material}, the material this room is made of. Without it the drawing is a correctly composed grey box that could be any room in the building — put it on ${WANT.material.min}–12 things that would genuinely be made of it, across all three depth layers, never on the walls or floor.`,
    )
  }

  const parts = { density, depth, calm, receding, lit, banding, obedience, motion, material }
  const weights: Record<keyof typeof parts, number> = {
    density: 1,
    depth: 1.6,
    calm: 1.4,
    receding: 0.8,
    lit: 1.2,
    banding: 0.8,
    obedience: 1.2,
    motion: 1,
    // Weighted like depth: a room with no material in it is the exact drawing
    // this whole pipeline was producing before, and it scored well.
    material: 1.6,
  }
  const total =
    Object.entries(parts).reduce((sum, [key, value]) => sum + value * weights[key as keyof typeof parts], 0) /
    Object.values(weights).reduce((sum, weight) => sum + weight, 0)

  // Not scored, only said: a lit thing in the middle of the floor is a lamp
  // nobody can walk around, and it is easier to move than to argue about.
  if (litBelow > 0) {
    notes.push('Something is glowing in the middle of the floor. Lit shapes belong above the horizon or at the far edges.')
  }

  return { total, notes, parts }
}
