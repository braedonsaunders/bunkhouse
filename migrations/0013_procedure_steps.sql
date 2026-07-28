-- Procedures gain real structure: an authored step-by-step body instead of one
-- prose blob. `content` is what the operator edits; `body` stays the markdown a
-- hand reads and a run pins, rendered from `content` on every write. Revisions
-- authored before this migration keep `content` null and render from `body`.
ALTER TABLE "procedure_revisions" ADD COLUMN "content" jsonb;
