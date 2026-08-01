import assert from 'node:assert/strict'
import { sanitiseSceneSvg } from '../src/lib/scene-svg'
import { readShapes } from '../src/lib/scene-geometry'
import { scoreBackdrop, FRAME } from '../src/lib/scene-score'
import { lightPools } from '../src/lib/scene-lighting'
import { shotFor, SHOT_COMBINATIONS } from '../src/lib/scene-shot'
import { keepMotionClasses } from '../src/lib/scene-motion'
import { PALETTES } from '../src/lib/scene-palette'

/*
 * The drawn rooms: what survives the sanitiser, what the scorer can see, and
 * where the light lands.
 *
 * Run with --conditions=react-server, because scene-svg.ts is server-only.
 */

const palette = PALETTES.dark

// --- the motion vocabulary --------------------------------------------------
assert.equal(keepMotionClasses('bhs-glow'), 'bhs-glow', 'a motion class is kept')
assert.equal(keepMotionClasses('bhs-glow bhs-blink'), 'bhs-glow bhs-blink', 'several are kept')
assert.equal(keepMotionClasses('fixed inset-0 z-50'), '', 'the application’s own utilities are not motion')
assert.equal(keepMotionClasses('bhs-glow absolute'), 'bhs-glow', 'the good name survives its passenger')

// --- the sanitiser ----------------------------------------------------------
const drawn = sanitiseSceneSvg(
  `<svg viewBox="0 0 1600 900">
     <rect x="0" y="0" width="1600" height="468" fill="#111c30" class="bhs-glow" />
     <rect x="0" y="468" width="1600" height="432" fill="#0b1220" class="fixed inset-0 z-[999]" />
     <circle cx="800" cy="200" r="20" fill="#8fc7f0" class="bhs-blink extra" />
     <script>alert(1)</script>
     <rect x="10" y="10" width="10" height="10" onload="alert(2)" fill="#1a2740" />
   </svg>`,
)
assert.ok('svg' in drawn && drawn.svg, 'a drawing with one bad class is cleaned, not rejected')
const cleaned = (drawn as { svg: string }).svg
assert.match(cleaned, /class="bhs-glow"/, 'motion survives')
assert.match(cleaned, /class="bhs-blink"/, 'motion survives alongside a stripped name')
assert.doesNotMatch(cleaned, /fixed|inset-0|z-\[999\]|extra/, 'positioning utilities do not')
assert.doesNotMatch(cleaned, /script|onload/i, 'and nothing that can act does')

// A drawing whose only class is junk loses the attribute entirely rather than
// keeping an empty one.
const junk = sanitiseSceneSvg('<svg viewBox="0 0 1600 900"><rect width="10" height="10" class="pointer-events-auto" /></svg>')
assert.doesNotMatch((junk as { svg: string }).svg, /class/, 'an emptied class attribute is dropped')

// --- reading shapes back out ------------------------------------------------
const shapes = readShapes(
  `<svg><g class="bhs-glow"><rect x="100" y="50" width="200" height="80" fill="#8FC7F0" /></g>
    <circle cx="400" cy="300" r="25" fill="#f5a623" />
    <path d="M0 468 L 1600 468 L 1600 500 Z" fill="#0b1220" /></svg>`,
)
assert.equal(shapes.length, 3, 'every drawable shape is found')
assert.deepEqual(
  { x: shapes[0]!.x, y: shapes[0]!.y, width: shapes[0]!.width, height: shapes[0]!.height },
  { x: 100, y: 50, width: 200, height: 80 },
  'a rect is its own box',
)
assert.deepEqual(shapes[0]!.classes, ['bhs-glow'], 'a group lends its motion to what it holds')
assert.equal(shapes[0]!.fill, '#8fc7f0', 'fills are compared lower-cased')
assert.deepEqual(
  { x: shapes[1]!.x, y: shapes[1]!.y, width: shapes[1]!.width },
  { x: 375, y: 275, width: 50 },
  'a circle is boxed by its radius',
)
assert.equal(shapes[2]!.x, 0, 'a path is spanned by the numbers in its d')
assert.equal(shapes[2]!.width, 1600, 'across its full width')

// --- the scorer -------------------------------------------------------------
/** A drawing that does what the brief asks. */
function goodRoom(): string {
  const parts: string[] = []
  // A banded wall: four values above the horizon.
  parts.push(`<rect x="0" y="0" width="1600" height="120" fill="#0b1220" />`)
  parts.push(`<rect x="0" y="120" width="1600" height="240" fill="#111c30" />`)
  parts.push(`<rect x="0" y="360" width="1600" height="108" fill="#1a2740" />`)
  parts.push(`<rect x="0" y="468" width="1600" height="432" fill="#24344f" />`)
  // The near layer: cropped by both edges.
  parts.push(`<rect x="0" y="150" width="220" height="500" fill="#33455f" />`)
  parts.push(`<rect x="1380" y="120" width="220" height="540" fill="#33455f" />`)
  // Things standing on the horizon.
  for (let index = 0; index < 5; index++) {
    parts.push(`<rect x="${300 + index * 200}" y="${368}" width="120" height="100" fill="#1a2740" />`)
  }
  // Lit shapes, all above the horizon.
  for (let index = 0; index < 4; index++) {
    parts.push(`<rect x="${340 + index * 200}" y="300" width="60" height="40" fill="#8fc7f0" class="bhs-glow" />`)
  }
  // Perspective on the floor.
  for (let index = 0; index < 6; index++) {
    parts.push(`<line x1="800" y1="468" x2="${index * 320}" y2="900" stroke="#24344f" stroke-width="2" />`)
  }
  // Motion, and enough shapes to look finished.
  parts.push(`<circle cx="1200" cy="180" r="8" fill="#f5a623" class="bhs-blink" />`)
  parts.push(`<circle cx="1240" cy="180" r="8" fill="#f5a623" class="bhs-twinkle" />`)
  parts.push(`<rect x="700" y="60" width="80" height="18" fill="#8fc7f0" class="bhs-glow" />`)
  for (let index = 0; index < 80; index++) {
    parts.push(`<rect x="${20 + index * 18}" y="${140 + (index % 7) * 12}" width="12" height="8" fill="#24344f" />`)
  }
  return `<svg viewBox="0 0 1600 900">${parts.join('')}</svg>`
}

/** A drawing that does not: flat wall, cluttered floor, nothing lit, no motion. */
const poorRoom = `<svg viewBox="0 0 1600 900">
  <rect x="0" y="0" width="1600" height="468" fill="#111c30" />
  <rect x="0" y="468" width="1600" height="432" fill="#0b1220" />
  <rect x="700" y="600" width="240" height="220" fill="#ff00ff" />
  <rect x="600" y="620" width="200" height="200" fill="#00ff88" />
  <rect x="500" y="700" width="300" height="180" fill="#123456" />
</svg>`

const good = scoreBackdrop(goodRoom(), palette)
const poor = scoreBackdrop(poorRoom, palette)
assert.ok(good.total > poor.total, 'the drawing that obeys the brief wins')
assert.ok(good.total > 0.75, `a compliant drawing scores well (got ${good.total.toFixed(2)})`)
assert.ok(poor.total < 0.4, `a bad one does not (got ${poor.total.toFixed(2)})`)
assert.equal(good.notes.length, 0, `a compliant drawing has nothing to fix (got: ${good.notes.join(' | ')})`)

// The notes are the repair pass's instructions, so they have to name the actual
// faults rather than being a generic complaint.
const faults = poor.notes.join(' ')
assert.match(faults, /middle of the floor/, 'says the floor is blocked')
assert.match(faults, /near layer is missing/, 'says the frame has no near layer')
assert.match(faults, /lit shape/, 'says nothing is lit')
assert.match(faults, /move/, 'says nothing moves')
assert.match(faults, /palette/, 'says the colours are wrong')

// Every part is a fraction, or the weighting means nothing.
for (const [name, value] of Object.entries(good.parts)) {
  assert.ok(value >= 0 && value <= 1, `${name} is 0..1 (got ${value})`)
}

// --- where the light lands --------------------------------------------------
const pools = lightPools(goodRoom(), palette.lit)
assert.ok(pools.length > 0 && pools.length <= 3, `at most three pools (got ${pools.length})`)
for (const pool of pools) {
  assert.ok(pool.x >= 0 && pool.x <= 1, 'a pool sits inside the frame')
  assert.ok(pool.strength > 0 && pool.strength <= 1, 'and has a sane strength')
}
// Lit things below the horizon are not light sources for the floor.
assert.deepEqual(
  lightPools(
    `<svg><rect x="700" y="${FRAME.horizon + 200}" width="60" height="40" fill="${palette.lit}" /></svg>`,
    palette.lit,
  ),
  [],
  'a glow on the floor does not light the floor',
)
assert.deepEqual(lightPools('<svg><rect width="10" height="10" fill="#111c30" /></svg>', palette.lit), [], 'an unlit room has no pools')

// --- the shot ---------------------------------------------------------------
assert.deepEqual(shotFor('room#0'), shotFor('room#0'), 'the same seed is the same shot')
const spread = new Set(
  Array.from({ length: 200 }, (_unused, index) => JSON.stringify(shotFor(`seed#${index}`))),
)
assert.ok(spread.size > 150, `seeds spread across the combinations (got ${spread.size} of 200)`)
assert.ok(SHOT_COMBINATIONS > 400, `enough rooms to describe (got ${SHOT_COMBINATIONS})`)
// The three candidates within one draw must not be near-identical, which is
// what a single hash walked four times would give for consecutive seeds.
const siblings = new Set([0, 1, 2].map((index) => JSON.stringify(shotFor(`abc#${index}`))))
assert.equal(siblings.size, 3, 'the candidates in one draw are three different rooms')

console.log('backdrop: ok')
