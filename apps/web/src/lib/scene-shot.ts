/**
 * Where the variety comes from.
 *
 * Every generated room used to be asked for in identical words, so the only
 * thing separating one department from another was the sentence somebody typed.
 * Ask a model for "a room, horizon at 468, three depth layers" a dozen times
 * and you get a dozen versions of the same room — same flat back wall, same
 * window in the middle, same two plants.
 *
 * A shot is the part a director would decide and a client would not think to
 * mention: where the camera stands, how the room is shaped, what is lighting
 * it, what it is built from. Nobody is going to be asked to fill in four more
 * fields to get that — there is one sentence box and it stays one sentence box
 * — so the shot is sampled here instead, and the sentence always outranks it.
 *
 * Sampled, not fixed, and reseeded on every press: "draw another" has to be
 * able to come back with a genuinely different room rather than the same one
 * redrawn, and the candidates raced against each other within a single draw
 * differ for the same reason.
 */

export type Shot = {
  architecture: string
  light: string
  camera: string
  material: string
}

/**
 * The room's shape — what the back wall does, and what the walls do at the
 * edges of the frame. These change the silhouette of the picture, which is the
 * thing that reads first and the thing that was always the same.
 */
const ARCHITECTURE = [
  'The back wall is broken by a wide opening in its middle third — a doorway, an archway or a roller door — with another space visible beyond it, darker and lower in contrast than the room in front.',
  'The room is a corner: the back wall runs across about two thirds of the frame and a second wall turns away from it toward one edge, so two planes meet at a visible vertical seam.',
  'A long run of glazing fills the upper back wall, divided into bays by mullions, with something legible but low-contrast beyond it — a skyline, a yard, another floor of the same building.',
  'A mezzanine or upper walkway crosses the frame above the horizon, its underside darker than the wall behind it, with posts or a balustrade breaking the top third.',
  'The back wall is a working wall: floor-to-ceiling shelving, racking or pegboard filling most of it, receding slightly at one end.',
  'The far end of the room recedes down a short bay — parallel side walls converging toward a smaller back wall in the middle distance, so the frame reads as a room with depth rather than a wall with things in front of it.',
]

/**
 * The lighting rig. The hand-drawn rooms treat day and night as two different
 * rigs rather than two palettes, and a rig is what gives a flat drawing its
 * focal points.
 */
const LIGHT = [
  'Lit from directly overhead: a row of long ceiling fittings, each throwing a soft pool onto the floor below it, with the pools narrowing toward the horizon.',
  'Lit from one side: a strong warm spill entering from the left edge, so the left faces of everything are bright and the right faces fall into the wall colour.',
  'Lit mostly by what is in the room: screens, a lamp or two and a doorway, each a small bright shape with everything around it dim.',
  'Lit from behind: the opening or glazing in the back wall is the brightest thing in the picture, and everything in front of it is nearly a silhouette.',
  'Lit unevenly: one half of the room is bright and the other is in shade, with a soft diagonal edge between them across the floor.',
]

/**
 * Where the camera stands. This is what stops every picture being the same
 * head-on elevation, and what makes the near-edge cropping believable.
 */
const CAMERA = [
  'Stand slightly left of centre, so the vanishing point sits around a third of the way across and the right-hand wall shows more of its face.',
  'Stand slightly right of centre, so the vanishing point sits around two thirds of the way across and the left-hand wall shows more of its face.',
  'Stand dead centre and low, so the horizon feels close and the ceiling is barely in frame.',
  'Stand centre but back, so more floor is visible and the back wall sits smaller in the frame.',
]

/** What the room is made of. Texture and edge quality, not colour. */
const MATERIAL = [
  'Hard and industrial: exposed structure, steel edges, painted block, a sealed floor with visible bay joints.',
  'Warm and domestic: timber, soft furnishing, a rug, rounded edges, a floor with a plank direction.',
  'Clean and corporate: flush panels, glass, thin metal legs, a carpet tile grid that is only just visible.',
  'Old and worked-in: brick or board, mismatched furniture, tools and stock stacked where they are used.',
  'Sparse and new: large plain surfaces, a few pieces well spaced, most of the wall left empty.',
]

/** A small, stable hash. Same seed, same shot — so a test can pin one down. */
function hash(seed: string): number {
  let value = 2166136261
  for (let index = 0; index < seed.length; index++) {
    value ^= seed.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

/**
 * A shot for one drawing.
 *
 * Each dimension is drawn from its own mix of the seed rather than from
 * successive digits of one number: consecutive seeds ("…#0", "…#1") differ in
 * one character, and a single hash walked four times hands those neighbours
 * three identical choices out of four.
 */
export function shotFor(seed: string): Shot {
  const at = <T,>(list: readonly T[], salt: string): T => list[hash(`${salt}:${seed}`) % list.length]!
  return {
    architecture: at(ARCHITECTURE, 'architecture'),
    light: at(LIGHT, 'light'),
    camera: at(CAMERA, 'camera'),
    material: at(MATERIAL, 'material'),
  }
}

/** How many distinct rooms the sampler can describe. */
export const SHOT_COMBINATIONS = ARCHITECTURE.length * LIGHT.length * CAMERA.length * MATERIAL.length
