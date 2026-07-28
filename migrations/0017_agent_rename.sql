-- Rename the AI-employee record kind from "hand" to "agent" across every enum
-- that names it. RENAME VALUE rewrites the label in place, so existing rows,
-- indexes, and the append-only ledgers (memories, call transcripts) keep their
-- identity — no data is rewritten and no history is reinterpreted.
ALTER TYPE "public"."person_kind" RENAME VALUE 'hand' TO 'agent';--> statement-breakpoint
ALTER TYPE "public"."memory_scope" RENAME VALUE 'hand' TO 'agent';--> statement-breakpoint
ALTER TYPE "public"."memory_author" RENAME VALUE 'hand' TO 'agent';--> statement-breakpoint
ALTER TYPE "public"."call_speaker" RENAME VALUE 'hand' TO 'agent';
