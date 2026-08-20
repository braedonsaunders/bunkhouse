import assert from 'node:assert/strict'

// The sentence a duty run is handed about who receives its work. The failure
// this replaces was silent — "email the Owner" resolved by the model, freshly,
// every run — so the thing worth proving is that an unreachable recipient is
// LOUD rather than quietly dropped.

const { deliveryInstruction } = await import('../src/lib/delivery-targets')

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

console.log('the delivery instruction')

await check('a duty that declares nobody gets no addendum at all', () => {
  assert.equal(deliveryInstruction([]), '')
})

await check('each channel is named with the handle to use', () => {
  const text = deliveryInstruction([
    { via: 'email', handle: 'ksaunders@rassaun.com', label: 'Kevin Saunders', personId: 'k' },
    { via: 'chat', handle: 'Braedon Saunders', label: 'Braedon Saunders', personId: 'b' },
    { via: 'call', handle: '+15195551234', label: 'On-call', },
  ])
  assert.match(text, /Email Kevin Saunders at ksaunders@rassaun\.com/)
  assert.match(text, /Post in your conversation with Braedon Saunders \(use post_to_conversation\)/)
  assert.match(text, /Call On-call at \+15195551234/)
})

await check('the declared list is stated to override the instruction prose', () => {
  // The whole bug: an old sentence saying "the Owner" competing with the list,
  // and a model handed two answers picking one.
  const text = deliveryInstruction([{ via: 'email', handle: 'a@b.com', label: 'A' }])
  assert.match(text, /THIS LIST WINS/)
  assert.match(text, /authoritative recipient list/)
})

await check('an unreachable recipient is called out, not dropped', () => {
  const text = deliveryInstruction([
    { via: 'email', handle: 'ok@example.com', label: 'Reachable' },
    { via: 'email', handle: '', label: 'Gone', personId: 'x', problem: 'This recipient is no longer in the directory.' },
  ])
  assert.match(text, /CANNOT BE DONE: This recipient is no longer in the directory\./)
  assert.match(text, /Do not substitute someone else/)
  // And the reachable one still gets delivered to.
  assert.match(text, /Email Reachable at ok@example\.com/)
})

await check('no warning is added when everyone is reachable', () => {
  const text = deliveryInstruction([{ via: 'email', handle: 'ok@example.com', label: 'Reachable' }])
  assert.equal(/CANNOT BE DONE/.test(text), false)
  assert.equal(/Do not substitute/.test(text), false)
})

await check('every declared recipient appears exactly once', () => {
  const text = deliveryInstruction([
    { via: 'email', handle: 'one@example.com', label: 'One' },
    { via: 'email', handle: 'two@example.com', label: 'Two' },
    { via: 'chat', handle: 'Three', label: 'Three', personId: '3' },
  ])
  const lines = text.split('\n').filter((line) => line.startsWith('- '))
  assert.equal(lines.length, 3)
})

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
