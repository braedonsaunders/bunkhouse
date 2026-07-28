CREATE TYPE "public"."memory_author" AS ENUM('hand', 'human', 'consolidator');--> statement-breakpoint
CREATE TYPE "public"."memory_kind" AS ENUM('fact', 'episode', 'procedure', 'reflection');--> statement-breakpoint
CREATE TYPE "public"."memory_proposal_kind" AS ENUM('promote', 'merge', 'supersede', 'expire', 'edit');--> statement-breakpoint
CREATE TYPE "public"."memory_proposal_status" AS ENUM('open', 'approved', 'rejected', 'auto_applied');--> statement-breakpoint
CREATE TABLE "memory_links" (
	"tenant_id" uuid NOT NULL,
	"from_note" uuid NOT NULL,
	"to_note" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "memory_proposal_kind" NOT NULL,
	"note_id" uuid,
	"payload" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"proposed_by_person_id" uuid,
	"status" "memory_proposal_status" DEFAULT 'open' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "memory_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"rev" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"edited_by" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "kind" "memory_kind" DEFAULT 'fact' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "importance" smallint DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "valid_from" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "author" "memory_author" DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "use_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_links_pk" ON "memory_links" USING btree ("from_note","to_note");--> statement-breakpoint
CREATE INDEX "memory_links_to_idx" ON "memory_links" USING btree ("tenant_id","to_note");--> statement-breakpoint
CREATE INDEX "memory_proposals_open_idx" ON "memory_proposals" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_revisions_rev_key" ON "memory_revisions" USING btree ("note_id","rev");--> statement-breakpoint
CREATE INDEX "memories_live_idx" ON "memories" USING btree ("tenant_id","valid_until","pinned");