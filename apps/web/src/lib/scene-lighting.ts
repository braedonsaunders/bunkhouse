/**
 * The light a drawing cannot draw for itself.
 *
 * The hand-drawn rooms do not get their depth from their shapes. Each one lays
 * a pool of light on the floor under every fitting, a haze along the horizon,
 * and a vignette over the whole frame — soft, wide gradients that no model is
 * going to place correctly inside an SVG and that would cost a third of its
 * shape budget if it tried.
 *
 * So they are added over the top instead, in the app, from where the drawing's
 * own lit shapes ended up. That means it also improves every backdrop already
 * saved, without redrawing anything.
 */

import { readShapes } from './scene-geometry'
import { FRAME } from './scene-score'

export type LightPool = {
  /** Centre, as a fraction of the frame's width. */
  x: number
  /** Width, as a fraction of the frame's width. */
  spread: number
  /** 0 to 1, from how much lit area fed this pool. */
  strength: number
}

/** Lit shapes that sit within this far of each other become one pool. */
const CLUSTER = 0.14

/**
 * Where to put pools of light on the floor.
 *
 * Reads the shapes that glow — the palette's lit colour, or anything wearing a
 * glow class — takes those above the horizon, and clusters them across the
 * frame. Three at most: a pool under every screen in a bank of six is not
 * lighting, it is a smear.
 */
export function lightPools(svg: string, litColour: string | readonly string[]): LightPool[] {
  // A set rather than one colour: which palette a room was drawn in is not
  // recorded on the drawing, and every palette lights its room in its own
  // colour. The lit colours are distinct across all of them, so matching any
  // of them finds this room's pools without having to be told which it is.
  const lit = new Set((typeof litColour === 'string' ? [litColour] : litColour).map((c) => c.toLowerCase()))
  const glowing = readShapes(svg).filter(
    (shape) =>
      (lit.has(shape.fill ?? '') || shape.classes.some((name) => name === 'bhs-glow' || name === 'bhs-blink')) &&
      shape.y + shape.height <= FRAME.horizon + 40 &&
      shape.width > 4 &&
      shape.height > 4,
  )
  if (glowing.length === 0) return []

  // Area, not count: one big window should out-weigh four indicator LEDs.
  const points = glowing
    .map((shape) => ({
      x: (shape.x + shape.width / 2) / FRAME.width,
      weight: Math.min(shape.width * shape.height, 60_000),
    }))
    .filter((point) => point.x >= -0.1 && point.x <= 1.1)
    .sort((a, b) => a.x - b.x)

  const clusters: { x: number; weight: number }[] = []
  for (const point of points) {
    const last = clusters[clusters.length - 1]
    if (last && Math.abs(last.x - point.x) < CLUSTER) {
      // Weighted mean, so a cluster's centre follows its brightest member.
      const weight = last.weight + point.weight
      last.x = (last.x * last.weight + point.x * point.weight) / weight
      last.weight = weight
    } else {
      clusters.push({ x: point.x, weight: point.weight })
    }
  }

  const strongest = Math.max(...clusters.map((cluster) => cluster.weight))
  return clusters
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((cluster) => ({
      x: Math.min(0.95, Math.max(0.05, cluster.x)),
      // A wider pool for a bigger source, within reason.
      spread: 0.18 + 0.22 * Math.min(1, cluster.weight / 40_000),
      strength: Math.max(0.35, Math.min(1, cluster.weight / strongest)),
    }))
}
