ALTER TABLE "shell_sessions" ADD COLUMN "execution_id" text;--> statement-breakpoint
ALTER TABLE "shell_sessions" ADD COLUMN "output_truncated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shell_sessions" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
UPDATE "shell_sessions"
SET "finished_at" = "started_at" + ("duration_ms" * interval '1 millisecond')
WHERE "finished_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "shell_sessions_execution_idx"
ON "shell_sessions" USING btree ("tenant_id", "execution_id");--> statement-breakpoint
DROP TRIGGER IF EXISTS shell_sessions_immutable ON shell_sessions;--> statement-breakpoint
CREATE TRIGGER shell_sessions_immutable
BEFORE UPDATE OR DELETE ON shell_sessions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_ledger_change();
