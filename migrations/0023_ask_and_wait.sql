ALTER TABLE "runs" ADD COLUMN "waiting" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "consumed_message_ids" uuid[] DEFAULT '{}' NOT NULL;
