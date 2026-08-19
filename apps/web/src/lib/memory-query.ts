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
 * k damps how much a single leg's top ranks dominate. The literature's k=60
 * assumes the thousand-result lists web search fuses, where a long tail needs
 * flattening; over a candidate pool of a few dozen it flattens everything —
 * measured here, the fortieth result still scored 0.31 of the first, so the
 * whole pool arrived at the final ranking nearly tied and the flat usefulness
 * term decided the order. Which is the defect this change set exists to fix,
 * reintroduced one layer down.
 *
 * k=10 keeps the shape of RRF and gives a pool this size room to disagree:
 * first place is worth five times fortieth rather than three times.
 */
export const RRF_K = 10

/**
 * Repeat a read-only memory lookup once when the database connection has a
 * transient wobble. Memory ranking has no external effect, so replay is safe;
 * a second failure is still surfaced so callers can choose their fallback.
 *
 * This deliberately does not try to guess from driver-specific error codes.
 * Drizzle wraps node-postgres errors and deployments have produced both SQLSTATE
 * and socket-shaped causes. A deterministic SQL defect simply fails twice and
 * remains visible, while a dropped pooled connection gets one clean recovery.
 */
export async function retryMemoryRead<T>(
  read: () => Promise<T>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 2)
  const delayMs = Math.max(0, options.delayMs ?? 25)
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await read()
    } catch (error) {
      lastError = error
      if (attempt < attempts && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
  }
  throw lastError
}

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
 * What counts as full marks for relevance: being ranked first by two legs.
 *
 * A fixed scale, and both of the obvious alternatives are worse. Dividing by
 * the theoretical maximum `legs/(k+1)` makes the score depend on how many legs
 * happened to run — the same query over the same notes would rank differently
 * depending on whether pgvector is installed, and semantic recall is optional
 * by design. Dividing by the best score actually achieved always crowns
 * somebody: ask a question the Logbook has no answer to and the least
 * irrelevant note scores 1.0, which is how "no good match" turns into a
 * confident wrong one — the exact failure this whole change set exists to stop.
 *
 * Two legs agreeing is a genuinely good match and earns 1.0. One leg alone
 * earns about half, which is the honest signal that only one kind of search
 * liked it. Three legs agreeing is also 1.0 — there is no more to say.
 */
const FULL_MARKS = 2 / (RRF_K + 1)

/**
 * Put fused scores on a 0..1 scale, so relevance can be weighed against
 * importance and recency the way the plain `ts_rank_cd` used to be. Absolute,
 * not relative: a weak set stays weak.
 */
export function normalizeFusedScores(fused: Map<string, number>): Map<string, number> {
  return new Map([...fused].map(([id, score]) => [id, Math.min(1, score / FULL_MARKS)]))
}
