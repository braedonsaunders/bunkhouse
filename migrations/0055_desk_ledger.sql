-- The desk ledger (docs/agent-desk.md §3.19, §6.1): on a desk the agent types
-- in a terminal and clicks in a GUI as one continuous piece of work, so it gets
-- ONE session ledger and ONE typed, append-only event stream instead of the
-- three surfaces it replaces. Because per-command approval moved off the agent
-- path (§3.22), this ledger now carries more of the governance weight than the
-- ledgers it supersedes — it is not optional and it is not best-effort.
--
-- browser_sessions, browser_steps and shell_sessions are NOT dropped and NOT
-- migrated: existing rows are audit history and stay readable exactly where
-- they are. Those tables simply stop receiving writes from this migration on.
--
-- desk_events.kind is text, deliberately not an enum: the kind list grows with
-- the desk (browser steps, shared-folder writes, egress denials) and a ledger
-- must never refuse a row because the taxonomy moved first. The typed union
-- lives in apps/web/src/db/schema/desk.ts.
CREATE TYPE "public"."desk_session_status" AS ENUM('active', 'ended', 'failed');--> statement-breakpoint
CREATE TYPE "public"."desk_job_status" AS ENUM('running', 'exited', 'killed');--> statement-breakpoint
CREATE TABLE "desk_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"status" "desk_session_status" DEFAULT 'active' NOT NULL,
	"screen_opened_at" timestamp with time zone,
	"screen_reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "desk_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"detail" jsonb NOT NULL,
	"screenshot_file_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "background_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"job_id" text NOT NULL,
	"command" text NOT NULL,
	"status" "desk_job_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"exited_at" timestamp with time zone,
	"exit_code" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE INDEX "desk_sessions_run_idx" ON "desk_sessions" USING btree ("tenant_id","run_id");--> statement-breakpoint
CREATE INDEX "desk_sessions_person_idx" ON "desk_sessions" USING btree ("tenant_id","person_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "desk_events_seq_key" ON "desk_events" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "desk_events_session_idx" ON "desk_events" USING btree ("tenant_id","session_id");--> statement-breakpoint
-- An operator must be able to find and kill a daemon: the open-jobs list is
-- the query that matters, so it gets the index.
CREATE INDEX "background_jobs_open_idx" ON "background_jobs" USING btree ("tenant_id","status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "background_jobs_job_key" ON "background_jobs" USING btree ("session_id","job_id");--> statement-breakpoint
-- Append-only: events are evidence. Sessions and jobs are stamped (ended_at,
-- exit status), so they update; the event stream never does.
DROP TRIGGER IF EXISTS desk_events_immutable ON desk_events;--> statement-breakpoint
CREATE TRIGGER desk_events_immutable
BEFORE UPDATE OR DELETE ON desk_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_ledger_change();

ALTER TABLE desk_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE desk_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON desk_sessions;
CREATE POLICY tenant_isolation ON desk_sessions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE desk_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE desk_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON desk_events;
CREATE POLICY tenant_isolation ON desk_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE background_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE background_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON background_jobs;
CREATE POLICY tenant_isolation ON background_jobs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
