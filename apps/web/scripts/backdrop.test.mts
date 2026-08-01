import assert from 'node:assert/strict'
import { namespaceSvgIds } from '../src/lib/scene-ids'
import { sanitiseSceneSvg } from '../src/lib/scene-svg'
import { readShapes } from '../src/lib/scene-geometry'
import { scoreBackdrop, FRAME } from '../src/lib/scene-score'
import { lightPools } from '../src/lib/scene-lighting'
import { shotFor, SHOT_COMBINATIONS } from '../src/lib/scene-shot'
import { keepMotionClasses } from '../src/lib/scene-motion'
import { BACKDROP_PALETTES, DEFAULT_PALETTE, paletteFor } from '../src/lib/scene-palette'
import { toLightBackdrop } from '../src/lib/scene-recolour'

/*
 * The drawn rooms: what survives the sanitiser, what the scorer can see, and
 * where the light lands.
 *
 * Run with --conditions=react-server, because scene-svg.ts is server-only.
 */

const palette = DEFAULT_PALETTE.dark

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
  for (let index = 0; index < 7; index++) {
    parts.push(`<rect x="${340 + index * 160}" y="300" width="60" height="40" fill="#8fc7f0" class="bhs-glow" />`)
  }
  parts.push(`<rect x="520" y="250" width="26" height="18" fill="#d7ecff" />`)
  // Perspective on the floor.
  for (let index = 0; index < 6; index++) {
    parts.push(`<line x1="800" y1="468" x2="${index * 320}" y2="900" stroke="#24344f" stroke-width="2" />`)
  }
  // The room's own material, on things that would be made of it. Without
  // these the drawing is a correctly composed grey box that could be anywhere.
  for (let index = 0; index < 14; index++) {
    const material = index % 2 === 0 ? '#5b7fa6' : '#a2794f'
    parts.push(`<rect x="${320 + index * 80}" y="${200 + (index % 3) * 40}" width="34" height="22" fill="${material}" />`)
  }
  // Motion, and enough shapes to look finished.
  parts.push(`<circle cx="1200" cy="180" r="8" fill="#f5a623" class="bhs-blink" />`)
  parts.push(`<circle cx="1240" cy="180" r="8" fill="#f5a623" class="bhs-twinkle" />`)
  parts.push(`<rect x="700" y="60" width="80" height="18" fill="#8fc7f0" class="bhs-glow" />`)
  for (let index = 0; index < 150; index++) {
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
// Whole rooms have to differ, not just the histogram of their ceilings: with
// 600 combinations, 200 draws of a well-mixed hash land on about 170 distinct
// rooms, and a hash whose dimensions stay correlated lands on far fewer while
// still looking uniform one dimension at a time.
const spread = new Set(
  Array.from({ length: 200 }, (_unused, index) => JSON.stringify(shotFor(`seed#${index}`))),
)
const ideal = Math.round(SHOT_COMBINATIONS * (1 - Math.pow(1 - 1 / SHOT_COMBINATIONS, 200)))
assert.ok(spread.size >= ideal * 0.94, `200 seeds spread across ${spread.size} rooms, near the ideal ${ideal}`)
assert.ok(SHOT_COMBINATIONS > 400, `enough rooms to describe (got ${SHOT_COMBINATIONS})`)
// The three candidates within one draw must not be near-identical, which is
// what a single hash walked four times would give for consecutive seeds.
const siblings = new Set([0, 1, 2].map((index) => JSON.stringify(shotFor(`abc#${index}`))))
assert.equal(siblings.size, 3, 'the candidates in one draw are three different rooms')

console.log('backdrop: ok')

/* -- a room is drawn in what it is made of --------------------------------- */

// The failure this replaced: every room, whatever it was, came back in the same
// five navies, because the only palette axis was dark and light.
const steel = paletteFor('industrial fabrication shop welding steel metal')
const copper = paletteFor('detailed industrial electrical contractor workspace, cables tools panels')
assert.notEqual(steel.slug, copper.slug, 'a fabrication shop and an electrical room are not the same room')
assert.equal(steel.slug, 'steel')
assert.equal(copper.slug, 'copper')
assert.equal(paletteFor('a quiet room with a door').slug, DEFAULT_PALETTE.slug, 'anything unrecognised stays neutral')
// Longest cue wins, so a server room is racks rather than storage.
assert.equal(paletteFor('the server room, next to the parts store').slug, 'cyan')

// Deterministic, because a redraw of the same room must not change its colour.
assert.equal(paletteFor('welding shop').slug, paletteFor('welding shop').slug)

// Every palette is genuinely a different room, not a relabelled one.
const materials = new Set(BACKDROP_PALETTES.map((p) => p.dark.material))
assert.equal(materials.size, BACKDROP_PALETTES.length, 'each palette has its own material colour')
const seconds = new Set(BACKDROP_PALETTES.map((p) => p.dark.material2))
assert.equal(seconds.size, BACKDROP_PALETTES.length, 'and its own second material')
const floors = new Set(BACKDROP_PALETTES.map((p) => p.dark.colours[0]))
assert.equal(floors.size, BACKDROP_PALETTES.length, 'and its own darkest value, so the rooms do not share a shell')
for (const palette of BACKDROP_PALETTES) {
  assert.equal(palette.dark.colours.length, 6, `${palette.slug} keeps the six-value ramp`)
  assert.equal(palette.light.colours.length, 6, `${palette.slug} keeps it in daylight too`)
  assert.equal(palette.dark.accent, palette.light.accent, `${palette.slug} keeps the brand accent through the switch`)
  // Two materials, and they have to be genuinely different or the second one
  // is doing no work at all.
  assert.notEqual(palette.dark.material, palette.dark.material2, `${palette.slug} has two distinct materials`)
  assert.notEqual(palette.dark.lit, palette.dark.hot, `${palette.slug} has a hot light distinct from its lit`)
}

// The daylight version is derived through the room's own palette: mapping a
// steel shop through slate's ramp would repaint it a different material.
const steelRoom = `<svg viewBox="0 0 1600 900"><rect fill="${steel.dark.material}" /><rect fill="${steel.dark.colours[0]}" /></svg>`
const inDaylight = toLightBackdrop(steelRoom, steel)
assert.ok(inDaylight.includes(steel.light.material), 'the material survives into daylight as itself')
const extras = `<svg><rect fill="${steel.dark.material2}" /><rect fill="${steel.dark.hot}" /></svg>`
const extrasLit = toLightBackdrop(extras, steel)
assert.ok(extrasLit.includes(steel.light.material2), 'so does the second material')
assert.ok(extrasLit.includes(steel.light.hot), 'and the hot light')
assert.ok(inDaylight.includes(steel.light.colours[0]!), 'and so does the structure')
assert.ok(!inDaylight.includes(steel.dark.material), 'nothing dark is left behind')

console.log('backdrop palettes: ok')

/* -- two rooms on one page ------------------------------------------------- */

// The bug: every generated room names its gradients for what they are, so two
// of them in one document collide and the second paints itself with the
// first's. Valid markup, resolving references, wrong room.
const withGradient = `<svg viewBox="0 0 1600 900"><defs><linearGradient id="floorLight"><stop stop-color="#111c30"/></linearGradient></defs><rect fill="url(#floorLight)" /><use href="#floorLight" /></svg>`
const a = namespaceSvgIds(withGradient, 'r1')
const b = namespaceSvgIds(withGradient, 'r2')
assert.ok(a.includes('id="r1-floorLight"') && a.includes('url(#r1-floorLight)'), 'ids and references move together')
assert.ok(a.includes('href="#r1-floorLight"'), 'and so do href references')
assert.ok(!a.includes('"floorLight"'), 'nothing is left pointing at the bare id')
assert.equal(a.match(/r1-floorLight/g)?.length, 3, 'every occurrence is renamed')
const shared = new Set([...a.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))
for (const id of [...b.matchAll(/id="([^"]+)"/g)].map((m) => m[1])) {
  assert.ok(!shared.has(id!), 'two rooms on one page share no ids at all')
}
// A drawing with nothing to namespace comes back untouched, not rebuilt.
const plain = `<svg viewBox="0 0 1600 900"><rect fill="#111c30" /></svg>`
assert.equal(namespaceSvgIds(plain, 'r1'), plain)

console.log('backdrop ids: ok')
