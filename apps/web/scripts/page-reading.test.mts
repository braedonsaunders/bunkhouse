import assert from 'node:assert/strict'
import { readPage, type SeeingModel } from '../src/lib/page-reading'

/**
 * The perception contract: whatever a page is made of, asking to look at it
 * returns what is on it. Every case here is a real call that went wrong before
 * the routes were collapsed into one ability.
 *
 * `readWebpage` is the only thing these cannot fake — it reaches the network —
 * so each case uses a URL that cannot resolve, which makes the fetch fail fast
 * and puts the interesting routes under test. The fetch-answers case is proved
 * by the browser never being asked.
 */

const page = (text: string, extra: Record<string, unknown> = {}) => ({
  url: 'https://example.invalid/menu',
  title: 'Menu',
  text,
  ...extra,
})

const seeingModel = (answer: string, onCall?: () => void): SeeingModel => ({
  describe: async () => {
    onCall?.()
    return answer
  },
})

// --- a page with real text is read where it is found ------------------------
{
  let visits = 0
  const reading = await readPage({
    url: 'https://nothing-here.invalid/article',
    visit: async () => {
      visits += 1
      return page('x'.repeat(400))
    },
    seeing: null,
  })
  assert.equal(reading.route, 'visited')
  assert.equal(visits, 1, 'the browser is asked exactly once')
  assert.ok(reading.text.length >= 200)
}

// --- the menu that is a photograph -----------------------------------------
// The failure this contract exists for: the fetch returns nothing because the
// page is images, the browser returns nothing for the same reason, and the
// caller sits watching that menu on their own screen being told "still
// looking". A model that can see reads it out instead.
{
  let described = 0
  const reading = await readPage({
    url: 'https://nothing-here.invalid/menu',
    visit: async () => page('', { screenshot: { mediaType: 'image/jpeg', data: 'AAAA', label: 'the page' } }),
    seeing: seeingModel('Sharables: dill pickle fries, poutine, mozzarella sticks.', () => {
      described += 1
    }),
  })
  assert.equal(reading.route, 'described')
  assert.equal(described, 1)
  assert.match(reading.text, /pickle fries/)
  assert.equal(reading.unreadable, undefined, 'a page that was read is not reported unreadable')
}

// --- nothing connected can see ---------------------------------------------
// Then the contract does not pretend. It says so, so the guarantee upstream —
// never describe a screen you cannot see — has something true to stand on.
{
  const reading = await readPage({
    url: 'https://nothing-here.invalid/menu',
    visit: async () => page('', { screenshot: { mediaType: 'image/jpeg', data: 'AAAA', label: 'the page' } }),
    seeing: null,
  })
  assert.equal(reading.route, 'visited')
  assert.ok(reading.unreadable, 'a page nothing could read says so')
  assert.match(reading.unreadable!, /look at a picture/)
}

// --- a describing model that fails is an enrichment, not the step ----------
{
  const reading = await readPage({
    url: 'https://nothing-here.invalid/menu',
    visit: async () => page('a short line', { screenshot: { mediaType: 'image/jpeg', data: 'AAAA', label: 'the page' } }),
    seeing: { describe: async () => Promise.reject(new Error('vision provider is down')) },
  })
  assert.equal(reading.route, 'visited')
  assert.equal(reading.text, 'a short line', 'whatever the page did give survives')
  assert.ok(reading.unreadable)
}

// --- no browser on this call -----------------------------------------------
// The regression that left an agent whose dial parks the browser unable to
// read anything at all: it must still get an answer, and an honest one.
{
  const reading = await readPage({ url: 'https://nothing-here.invalid/x', visit: null, seeing: null })
  assert.equal(reading.route, 'fetched')
  assert.ok(reading.unreadable, 'with no browser and no fetch, the page is reported unreadable')
  assert.equal(reading.text, '')
}

console.log('page reading: fetched, visited, described, and honest when nothing could read it')
