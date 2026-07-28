-- Flexible duty scheduling: a timezone the pattern resolves in, plus the
-- bounds that let a recurrence stop on its own.
--
-- `timezone` is the important fix, not just a new feature. Cron patterns were
-- being resolved in whatever timezone the worker process happened to run in,
-- so a duty an operator set for "9am Monday" fired at 9am wherever the worker
-- lives. Existing rows stay null and fall back to the hand's own timezone.
--
-- starts_at / ends_at / max_runs express "not before", "not after", and "at
-- most N times"; run_count is the counter max_runs is measured against. Rows
-- that predate this migration start at 0 — no existing duty sets max_runs, so
-- the undercount is never read.
ALTER TABLE "duties" ADD COLUMN "timezone" text;
--> statement-breakpoint
ALTER TABLE "duties" ADD COLUMN "starts_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "duties" ADD COLUMN "ends_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "duties" ADD COLUMN "max_runs" integer;
--> statement-breakpoint
ALTER TABLE "duties" ADD COLUMN "run_count" integer NOT NULL DEFAULT 0;
