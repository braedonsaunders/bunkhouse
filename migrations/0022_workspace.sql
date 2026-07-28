CREATE TYPE "public"."shell_session_status" AS ENUM('completed', 'failed', 'timeout');--> statement-breakpoint
CREATE TABLE "shell_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"run_id" uuid,
	"command" text NOT NULL,
	"cwd" text DEFAULT '.' NOT NULL,
	"status" "shell_session_status" NOT NULL,
	"exit_code" integer,
	"output" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE INDEX "shell_sessions_person_idx" ON "shell_sessions" USING btree ("tenant_id","person_id","started_at");--> statement-breakpoint
CREATE INDEX "shell_sessions_run_idx" ON "shell_sessions" USING btree ("tenant_id","run_id");

ALTER TABLE shell_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE shell_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON shell_sessions;
CREATE POLICY tenant_isolation ON shell_sessions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
