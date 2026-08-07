/**
 * How a question becomes a query, and how three opinions become one ranking.
 *
 * The defect these were written for, measured on the live Logbook: the note
 * "Overdue A/R aging breakdown pulled for Braedon Aug 6 2026" ranks 2.2 for the
 * query `aging` and 0.0 for `overdue receivables aging` — because
 * `websearch_to_tsquery` ANDs its terms and the note never says "receivables".
 * A zeroed lexical leg did not return nothing; the score is a weighted sum, so
 * retrieval quietly fell back to importance and recency and handed the agent
 * eight confident, unrelated notes.
 */
import assert from 'node:assert/strict'
import {
  RRF_K,
  anyTermQuery,
  normalizeFused,
  reciprocalRankFusion,
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

// --- putting a fused score back on a 0..1 scale -----------------------------
{
  // Top of every leg is the best possible, and that is 1.
  const legs = 3
  const perfect = reciprocalRankFusion([['a'], ['a'], ['a']]).get('a')!
  assert.equal(normalizeFused(perfect, legs), 1, 'first in all three legs normalises to 1')

  assert.equal(normalizeFused(0, legs), 0, 'ranked by nothing scores nothing')
  assert.ok(normalizeFused(1 / (RRF_K + 1), legs) < 1, 'first in one leg of three is not a perfect score')
  assert.ok(normalizeFused(999, legs) <= 1, 'the scale is clamped')
  assert.equal(normalizeFused(1, 0), 0, 'no legs is not a division by zero')
  console.log('memory query: fused relevance lands on the same 0..1 scale the weights expect')
}
