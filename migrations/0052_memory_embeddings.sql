-- Semantic recall for the Logbook.
--
-- Retrieval was lexical only, and `websearch_to_tsquery` ANDs its terms: one
-- word a note does not happen to use zeroes the whole match. Measured on the
-- live corpus — "aging" ranks the A/R note at 2.2, "overdue receivables aging"
-- ranks EVERYTHING at 0.0. Worse, the score is a weighted sum, so a zeroed
-- lexical leg does not return nothing; it silently falls back to importance and
-- recency and hands the agent eight confident-looking notes that have nothing
-- to do with what was asked.
--
-- The lexical half of that fix needs no schema. This file is the other half,
-- and it is CONDITIONAL: `CREATE EXTENSION vector` requires a superuser, and
-- the role migrations run as is not one on this cluster. So the column is added
-- only where pgvector is already installed, and the migration is a no-op
-- everywhere else rather than a failure that blocks every migration behind it.
--
-- To turn semantic recall on, a database superuser runs:
--     CREATE EXTENSION vector;
-- and then anyone runs:
--     pnpm --filter web exec tsx --env-file=.env.local scripts/enable-semantic-recall.mts
-- which adds the column, the index, and backfills every note. Until then
-- retrieval runs on its two lexical legs and nothing is broken.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);
    -- HNSW over cosine distance, on the live set only — superseded notes are
    -- never retrieved, so they are not worth indexing.
    CREATE INDEX IF NOT EXISTS "memories_embedding_idx"
      ON "memories" USING hnsw ("embedding" vector_cosine_ops)
      WHERE "valid_until" IS NULL AND "embedding" IS NOT NULL;
  ELSE
    RAISE NOTICE 'pgvector is not installed, so semantic recall stays off. A superuser runs CREATE EXTENSION vector, then scripts/enable-semantic-recall.mts finishes the job.';
  END IF;
END $$;
