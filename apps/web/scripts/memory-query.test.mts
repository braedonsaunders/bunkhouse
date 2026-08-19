/**
 * How a question becomes a query, and how three opinions become one ranking.
 *
 * The defect these were written for, measured on the live Logbook: the note
 * "Overdue A/R aging breakdown pulled for Jordan Aug 6 2026" ranks 2.2 for the
 * query `aging` and 0.0 for `overdue receivables aging` — because
 * `websearch_to_tsquery` ANDs its terms and the note never says "receivables".
 * A zeroed lexical leg did not return nothing; the score is a weighted sum, so
 * retrieval quietly fell back to importance and recency and handed the agent
 * eight confident, unrelated notes.
 */
import assert from 'node:assert/strict'
import {
  anyTermQuery,
  normalizeFusedScores,
  reciprocalRankFusion,
  retryMemoryRead,
  searchTerms,
} from '../src/lib/memory-query'

// --- the words worth searching for ------------------------------------------
{
  assert.deepEqual(searchTerms('overdue receivables aging'), ['overdue', 'receivables', 'aging'])
  assert.deepEqual(
    searchTerms('who is behind on paying us'),
    ['behind', 'paying'],
    'stopwords carry no signal and are dropped',
  )
  assert.deepEqual(
    searchTerms('A/R aging — Q3, 2026!'),
    ['aging', 'q3', '2026'],
    'punctuation splits words; single letters carry no signal and go',
  )
  assert.deepEqual(searchTerms('the and of'), [], 'a question of pure stopwords has nothing to search')
  assert.deepEqual(searchTerms('aging AGING Aging'), ['aging'], 'case folds, duplicates collapse')
  console.log('memory query: the searchable words come out clean')
}

// --- a dropped read connection does not fail the employee's whole turn -----
{
  let calls = 0
  const result = await retryMemoryRead(
    async () => {
      calls += 1
      if (calls === 1) throw new Error('connection reset')
      return 'recovered'
    },
    { delayMs: 0 },
  )
  assert.equal(result, 'recovered')
  assert.equal(calls, 2, 'one read-only retry is allowed')

  await assert.rejects(
    retryMemoryRead(async () => { throw new Error('bad query') }, { delayMs: 0 }),
    /bad query/,
    'a persistent defect still surfaces after the bounded retry',
  )
  console.log('memory query: one transient read failure recovers, while a persistent defect remains visible')
}

// --- the disjunction that fixes the zeroing ---------------------------------
{
  assert.equal(anyTermQuery('overdue receivables aging'), 'overdue | receivables | aging')
  assert.equal(anyTermQuery('aging'), 'aging')
  assert.equal(anyTermQuery('the and of'), '', 'nothing searchable means no lexical opinion at all')

  // to_tsquery has its own operator syntax and throws on stray punctuation, so
  // the sanitising is a correctness requirement, not tidiness.
  for (const nasty of ["drop table; --", 'a & b | c:*!', "'; select 1 --", '<<>>']) {
    assert.ok(
      /^[a-z0-9 |]*$/.test(anyTermQuery(nasty)),
      `to_tsquery input must be sanitised: ${anyTermQuery(nasty)}`,
    )
  }
  console.log('memory query: a near-miss still has a query, and nothing hostile reaches to_tsquery')
}

// --- fusing the legs --------------------------------------------------------
{
  // The note both legs like beats the note one leg loves. This is the whole
  // point: a lexical miss is survivable and a semantic near-match is trusted
  // only when something else agrees with it.
  const lexical = ['loved-by-one', 'agreed', 'c']
  const semantic = ['x', 'agreed', 'y']
  const fused = reciprocalRankFusion([lexical, semantic])
  assert.ok(
    fused.get('agreed')! > fused.get('loved-by-one')!,
    'a note both legs rank beats a note only one leg ranks first',
  )

  // A note only one leg ever saw still scores — it is ranked, not discarded.
  assert.ok(fused.get('x')! > 0)

  // Rank order within a leg is preserved.
  assert.ok(fused.get('loved-by-one')! > fused.get('c')!)

  // Ties are ties, whichever leg they came from.
  const symmetric = reciprocalRankFusion([['a'], ['b']])
  assert.equal(symmetric.get('a'), symmetric.get('b'))
  console.log('memory query: fusion prefers agreement over any single leg’s enthusiasm')
}

// --- putting fused scores back on a 0..1 scale ------------------------------
{
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-9

  // Two legs agreeing is a good match and earns full marks.
  const agreed = normalizeFusedScores(reciprocalRankFusion([['top'], ['top']]))
  assert.equal(agreed.get('top'), 1, 'first in two legs is full relevance')

  // One leg alone earns about half — the honest signal that only one kind of
  // search liked it.
  const alone = normalizeFusedScores(reciprocalRankFusion([['solo'], []]))
  assert.ok(close(alone.get('solo')!, 0.5), `one leg alone is about half: ${alone.get('solo')}`)

  // The property a fixed scale exists for: semantic recall is optional, so
  // whether pgvector is installed must not rescale the legs that always ran.
  const twoLegs = normalizeFusedScores(reciprocalRankFusion([['a', 'b'], ['a', 'b']]))
  const threeLegs = normalizeFusedScores(reciprocalRankFusion([['a', 'b'], ['a', 'b'], ['a', 'b']]))
  assert.ok(close(twoLegs.get('a')!, threeLegs.get('a')!), 'an extra leg does not change the top score')

  // And the property achieved-max normalisation would have destroyed: asking a
  // question the Logbook has no good answer to must NOT crown the least
  // irrelevant note. A weak set stays weak.
  const weak = normalizeFusedScores(reciprocalRankFusion([[...Array(40).keys()].map(String)]))
  assert.ok(weak.get('39')! < 0.15, `a distant match stays low: ${weak.get('39')}`)
  assert.ok(weak.get('0')! <= 0.5, 'even the best of one leg is only half marks')

  assert.equal(normalizeFusedScores(new Map()).size, 0, 'nothing in, nothing out')
  console.log('memory query: relevance is an absolute scale — a weak set stays weak')
}
