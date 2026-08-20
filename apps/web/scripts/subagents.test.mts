import assert from 'node:assert/strict'

// Who may put whom straight onto work, and what counts as finished. The org
// gate is the part with teeth: an agent that could invoke sideways or upward
// would invert the reporting line the rest of the app reads as authority, and
// spend a budget that is not its own.

const { canInvoke, childIsFinished, MAX_CHILD_DEPTH, MAX_CHILDREN_PER_RUN } = await import('../src/lib/subagents')

let failures = 0
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

//  owner
//   └── director
//        ├── analyst
//        │    └── junior
//        └── writer
const ROSTER = [
  { id: 'owner', name: 'Owner', reportsToId: null },
  { id: 'director', name: 'Director', reportsToId: 'owner' },
  { id: 'analyst', name: 'Analyst', reportsToId: 'director' },
  { id: 'junior', name: 'Junior', reportsToId: 'analyst' },
  { id: 'writer', name: 'Writer', reportsToId: 'director' },
  { id: 'contractor', name: 'Contractor', reportsToId: null },
]

console.log('who may invoke whom')

await check('a manager may invoke a direct report', () => {
  assert.equal(canInvoke(ROSTER, 'director', 'analyst'), true)
})

await check('invocation reaches all the way down, not just one level', () => {
  assert.equal(canInvoke(ROSTER, 'director', 'junior'), true)
  assert.equal(canInvoke(ROSTER, 'owner', 'junior'), true)
})

await check('a peer cannot be invoked', () => {
  assert.equal(canInvoke(ROSTER, 'analyst', 'writer'), false)
})

await check('a manager cannot be invoked by their own report', () => {
  assert.equal(canInvoke(ROSTER, 'analyst', 'director'), false)
  assert.equal(canInvoke(ROSTER, 'junior', 'owner'), false)
})

await check('nobody may invoke themselves', () => {
  assert.equal(canInvoke(ROSTER, 'analyst', 'analyst'), false)
})

await check('someone outside the reporting tree is unreachable in both directions', () => {
  assert.equal(canInvoke(ROSTER, 'owner', 'contractor'), false)
  assert.equal(canInvoke(ROSTER, 'contractor', 'junior'), false)
})

await check('an unknown id is refused rather than treated as reachable', () => {
  assert.equal(canInvoke(ROSTER, 'director', 'ghost'), false)
  assert.equal(canInvoke(ROSTER, 'ghost', 'analyst'), false)
})

await check('a cycle in the roster terminates instead of hanging', () => {
  // assertValidManager forbids these on write, but a guard that bounds spend
  // must not depend on every past write having been correct.
  const looped = [
    { id: 'a', name: 'A', reportsToId: 'b' },
    { id: 'b', name: 'B', reportsToId: 'a' },
  ]
  assert.equal(canInvoke(looped, 'a', 'b'), true)
  assert.equal(canInvoke(looped, 'b', 'a'), true)
})

console.log('collection')

await check('only terminal states count as finished', () => {
  assert.equal(childIsFinished('completed'), true)
  assert.equal(childIsFinished('failed'), true)
  assert.equal(childIsFinished('cancelled'), true)
  assert.equal(childIsFinished('running'), false)
  // A child parked on an approval is emphatically not done: reporting it as
  // finished would hand the parent an empty answer and lose the request.
  assert.equal(childIsFinished('waiting_approval'), false)
  assert.equal(childIsFinished('waiting_reply'), false)
  assert.equal(childIsFinished('waiting_credential'), false)
})

console.log('bounds')

await check('the fan-out and depth caps are real numbers', () => {
  assert.ok(MAX_CHILDREN_PER_RUN > 0 && MAX_CHILDREN_PER_RUN <= 50)
  assert.ok(MAX_CHILD_DEPTH >= 1 && MAX_CHILD_DEPTH <= 5)
})

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
