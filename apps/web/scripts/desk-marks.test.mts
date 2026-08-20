import assert from 'node:assert/strict'
import sharp from 'sharp'

// Set-of-marks, proved without a desk: what gets a badge and what does not,
// what the numbering means, and the two invariants the overlay must not break
// — the picture keeps its dimensions, and a frame with nothing to mark comes
// back byte-identical so the ledger's frame deduplicator is untouched.

const { collectMarks, drawMarks, markLegend } = await import('../src/lib/desk-marks')

const SCREEN = { width: 1280, height: 900 }

type Node = {
  id: string
  role: string
  name: string | null
  actions: string[]
  bounds: { x: number; y: number; width: number; height: number } | null
  children: Node[]
}

function node(partial: Partial<Node> & { id: string }): Node {
  return {
    role: 'push button',
    name: 'Button',
    actions: ['click'],
    bounds: { x: 10, y: 10, width: 80, height: 30 },
    children: [],
    ...partial,
  }
}

/** A root big enough to be a container, so it never competes for a badge. */
function rootWith(children: Node[]): Node {
  return node({
    id: '0',
    role: 'frame',
    name: 'Window',
    actions: [],
    bounds: { x: 0, y: 0, width: SCREEN.width, height: SCREEN.height },
    children,
  })
}

let failures = 0
/**
 * Awaited, deliberately: half these checks are async, and a `try` around an
 * un-awaited promise catches nothing — every overlay failure would surface as
 * an unhandled rejection and the suite would report success.
 */
async function check(what: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run()
    console.log(`  ok   ${what}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${what}`)
    console.log(`       ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('selection')

await check('a control with an action and real bounds is marked', () => {
  const marks = collectMarks(rootWith([node({ id: '0/0', name: 'Save' })]), SCREEN)
  assert.equal(marks.length, 1)
  assert.equal(marks[0].mark, 1)
  assert.equal(marks[0].nodeId, '0/0')
  assert.equal(marks[0].name, 'Save')
})

await check('marks are numbered in reading order, not tree order', () => {
  const marks = collectMarks(
    rootWith([
      node({ id: '0/0', name: 'bottom', bounds: { x: 40, y: 500, width: 80, height: 30 } }),
      node({ id: '0/1', name: 'top-right', bounds: { x: 900, y: 100, width: 80, height: 30 } }),
      node({ id: '0/2', name: 'top-left', bounds: { x: 40, y: 100, width: 80, height: 30 } }),
    ]),
    SCREEN,
  )
  assert.deepEqual(
    marks.map((m) => m.name),
    ['top-left', 'top-right', 'bottom'],
  )
})

await check('a node with no bounds cannot be marked on a picture', () => {
  const marks = collectMarks(rootWith([node({ id: '0/0', bounds: null })]), SCREEN)
  assert.equal(marks.length, 0)
})

await check('a control too small to aim at is left off', () => {
  const marks = collectMarks(
    rootWith([node({ id: '0/0', bounds: { x: 10, y: 10, width: 4, height: 4 } })]),
    SCREEN,
  )
  assert.equal(marks.length, 0)
})

await check('an off-screen widget is left off rather than clamped onto the picture', () => {
  const marks = collectMarks(
    rootWith([
      node({ id: '0/0', name: 'left', bounds: { x: -400, y: 100, width: 80, height: 30 } }),
      node({ id: '0/1', name: 'below', bounds: { x: 100, y: 2000, width: 80, height: 30 } }),
    ]),
    SCREEN,
  )
  assert.equal(marks.length, 0)
})

await check('a container covering most of the screen is not a control', () => {
  const marks = collectMarks(
    rootWith([
      node({
        id: '0/0',
        role: 'panel',
        actions: ['click'],
        bounds: { x: 0, y: 0, width: 1200, height: 850 },
      }),
    ]),
    SCREEN,
  )
  assert.equal(marks.length, 0)
})

await check('a text entry is marked even though it exposes no action', () => {
  const marks = collectMarks(
    rootWith([node({ id: '0/0', role: 'text', name: 'Email', actions: [] })]),
    SCREEN,
  )
  assert.equal(marks.length, 1)
  assert.deepEqual(marks[0].actions, [])
})

await check('a decorative label with no action and no clickable role is left off', () => {
  const marks = collectMarks(
    rootWith([node({ id: '0/0', role: 'label', name: 'Heading', actions: [] })]),
    SCREEN,
  )
  assert.equal(marks.length, 0)
})

await check('wrappers reporting one rectangle collapse to the innermost control', () => {
  const rect = { x: 100, y: 100, width: 90, height: 28 }
  const marks = collectMarks(
    rootWith([
      node({
        id: '0/0',
        role: 'filler',
        name: 'wrapper',
        bounds: rect,
        children: [node({ id: '0/0/0', role: 'push button', name: 'Save', bounds: rect })],
      }),
    ]),
    SCREEN,
  )
  assert.equal(marks.length, 1)
  assert.equal(marks[0].nodeId, '0/0/0')
  assert.equal(marks[0].name, 'Save')
})

await check('the badge count is capped so the picture stays readable', () => {
  const many = Array.from({ length: 200 }, (_, index) =>
    node({
      id: `0/${index}`,
      name: `control ${index}`,
      bounds: { x: (index % 20) * 60, y: Math.floor(index / 20) * 40, width: 50, height: 24 },
    }),
  )
  const marks = collectMarks(rootWith(many), SCREEN)
  assert.equal(marks.length, 60)
  // Reading order means the cap drops the bottom of the screen, so the numbers
  // stay contiguous from 1 and mean the same thing they would uncapped.
  assert.deepEqual(
    marks.map((m) => m.mark),
    Array.from({ length: 60 }, (_, i) => i + 1),
  )
})

await check('a missing or unparseable tree yields no marks rather than throwing', () => {
  assert.deepEqual(collectMarks(null, SCREEN), [])
  assert.deepEqual(collectMarks(undefined, SCREEN), [])
  assert.deepEqual(collectMarks('not a tree', SCREEN), [])
  assert.deepEqual(collectMarks({ nonsense: true }, SCREEN), [])
})

await check('a degenerate screen size yields no marks', () => {
  assert.deepEqual(collectMarks(rootWith([node({ id: '0/0' })]), { width: 0, height: 0 }), [])
})

console.log('legend')

await check('the legend names controls and omits the coordinates', () => {
  const marks = collectMarks(
    rootWith([node({ id: '0/0', name: 'Save', role: 'push button', actions: ['click', 'press'] })]),
    SCREEN,
  )
  const legend = markLegend(marks)
  assert.deepEqual(legend, [{ mark: 1, role: 'push button', name: 'Save', actions: ['click', 'press'] }])
  assert.equal('bounds' in legend[0], false)
})

console.log('overlay')

const BLANK = await sharp({
  create: { width: SCREEN.width, height: SCREEN.height, channels: 3, background: '#202020' },
})
  .png()
  .toBuffer()

await check('the marked frame keeps the screen\'s exact dimensions', async () => {
  const marks = collectMarks(rootWith([node({ id: '0/0', name: 'Save' })]), SCREEN)
  const drawn = await drawMarks(BLANK, marks, SCREEN)
  const meta = await sharp(Buffer.from(drawn)).metadata()
  assert.equal(meta.width, SCREEN.width)
  assert.equal(meta.height, SCREEN.height)
})

await check('the overlay actually changes the pixels it draws on', async () => {
  const marks = collectMarks(rootWith([node({ id: '0/0', name: 'Save' })]), SCREEN)
  const drawn = await drawMarks(BLANK, marks, SCREEN)
  assert.notEqual(Buffer.from(drawn).toString('base64'), BLANK.toString('base64'))
})

await check('a frame with nothing to mark comes back byte-identical', async () => {
  const drawn = await drawMarks(BLANK, [], SCREEN)
  assert.equal(Buffer.from(drawn).toString('base64'), BLANK.toString('base64'))
})

await check('a control running off the edge still gets a badge inside the picture', async () => {
  const marks = collectMarks(
    rootWith([node({ id: '0/0', name: 'edge', bounds: { x: 1250, y: 0, width: 200, height: 40 } })]),
    SCREEN,
  )
  assert.equal(marks.length, 1)
  const drawn = await drawMarks(BLANK, marks, SCREEN)
  const meta = await sharp(Buffer.from(drawn)).metadata()
  assert.equal(meta.width, SCREEN.width)
  assert.equal(meta.height, SCREEN.height)
})

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
