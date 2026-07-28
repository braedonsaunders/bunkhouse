CREATE TYPE "public"."browser_session_status" AS ENUM('active', 'ended', 'failed');--> statement-breakpoint
CREATE TABLE "browser_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"status" "browser_session_status" DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "browser_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb NOT NULL,
	"screenshot_file_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "browser_sessions_run_idx" ON "browser_sessions" USING btree ("tenant_id","run_id");--> statement-breakpoint
CREATE INDEX "browser_sessions_person_idx" ON "browser_sessions" USING btree ("tenant_id","person_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_steps_seq_key" ON "browser_steps" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "browser_steps_session_idx" ON "browser_steps" USING btree ("tenant_id","session_id");

ALTER TABLE browser_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE browser_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON browser_sessions;
CREATE POLICY tenant_isolation ON browser_sessions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE browser_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE browser_steps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON browser_steps;
CREATE POLICY tenant_isolation ON browser_steps
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
