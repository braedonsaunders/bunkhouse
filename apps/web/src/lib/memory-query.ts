/**
 * Turning what somebody asked into something Postgres will match.
 *
 * `websearch_to_tsquery` ANDs its terms, which is right for a search box and
 * wrong for recall. Measured on the live Logbook: the query `aging` ranks the
 * A/R note at 2.2, and `overdue receivables aging` ranks EVERY note at 0.0 —
 * the note says "overdue" and "aging" but not "receivables", and one absent
 * word zeroes the conjunction.
 *
 * That would merely be a miss if the score were only relevance. It is not: the
 * retrieval score is a weighted sum of relevance, importance, recency and use,
 * so a zeroed lexical leg does not return nothing. It quietly returns whatever
 * is recent and important — eight confident-looking notes with no relation to
 * the question, and nothing anywhere saying the search failed.
 *
 * So the lexical leg asks two questions instead of one: the strict conjunction
 * (precise, when every word is really there) and the disjunction (recall, so a
 * near-miss still ranks). Fusion decides between them.
 *
 * Pure and framework-free, so the query-building can be tested without a
 * database — which is where the defect above lived.
 */

/**
 * Words too common to narrow anything. Postgres strips these itself when it
 * builds a tsvector, so leaving them in the disjunction contributes nothing and
 * risks `to_tsquery` erroring on an empty lexeme.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'for', 'from', 'had', 'has', 'have',
  'he', 'her', 'his', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of',
  'on', 'or', 'our', 'she', 'so', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they',
  'this', 'to', 'up', 'us', 'was', 'we', 'were', 'what', 'when', 'which', 'who', 'will', 'with',
  'you', 'your',
])

/**
 * The searchable words in a phrase: lowercased, stripped to alphanumerics, and
 * without the words that match everything. Sanitising to `[a-z0-9]` is also
 * what makes the result safe to hand to `to_tsquery`, which has its own
 * operator syntax and will throw on a stray `&` or `:`.
 */
export function searchTerms(query: string): string[] {
  const seen = new Set<string>()
  for (const raw of query.toLowerCase().split(/[^a-z0-9]+/)) {
    const term = raw.trim()
    if (!term || term.length < 2 || STOPWORDS.has(term)) continue
    seen.add(term)
  }
  return [...seen].slice(0, 24)
}

/**
 * The recall half of the lexical leg: `overdue | receivables | aging`. Empty
 * string when the question had no searchable words in it at all, which the
 * caller must treat as "no lexical opinion" rather than passing to Postgres —
 * `to_tsquery('')` is an error, not an empty result.
 */
export function anyTermQuery(query: string): string {
  return searchTerms(query).join(' | ')
}

/**
 * Reciprocal rank fusion. Each leg contributes `1/(k + rank)`, so a note both
 * legs like beats one that either leg loves — which is the property that makes
 * a lexical miss survivable and a semantic near-match trustworthy.
 *
 * k=60 is the value from the original RRF paper and the one every
 * implementation since has used; it is large enough that the difference
 * between rank 1 and rank 2 does not swamp the other leg's opinion.
 */
export const RRF_K = 60

/** Fuse ranked id lists into one score per id. Ranks are 1-based. */
export function reciprocalRankFusion(rankings: readonly (readonly string[])[], k = RRF_K): Map<string, number> {
  const fused = new Map<string, number>()
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + index + 1))
    })
  }
  return fused
}

/**
 * The most any one leg can contribute, used to put a fused score on a 0..1
 * scale so it can be weighed against importance and recency the way the plain
 * `ts_rank_cd` used to be.
 */
export function normalizeFused(score: number, legs: number, k = RRF_K): number {
  const best = legs / (k + 1)
  return best > 0 ? Math.min(1, score / best) : 0
}
