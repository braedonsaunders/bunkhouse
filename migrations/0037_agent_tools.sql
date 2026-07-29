CREATE TABLE "agent_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tool_id" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'not_installed' NOT NULL,
	"health" text DEFAULT 'unknown' NOT NULL,
	"install_dir" text,
	"bin_paths" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"installed_version" text,
	"last_error" text,
	"last_installed_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_tool_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tool_id" text NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"scope" text NOT NULL,
	"request" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"grant_expires_at" timestamp with time zone,
	"uses_remaining" integer
);
--> statement-breakpoint
CREATE TABLE "agent_tool_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tool_id" text NOT NULL,
	"command" text NOT NULL,
	"argv" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"exit_code" integer,
	"stdout" text DEFAULT '' NOT NULL,
	"stderr" text DEFAULT '' NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"actor" text NOT NULL,
	"approval_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_tools_tenant_tool_ux" ON "agent_tools" USING btree ("tenant_id","tool_id");--> statement-breakpoint
CREATE INDEX "agent_tools_status_idx" ON "agent_tools" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "agent_tool_approvals_scope_idx" ON "agent_tool_approvals" USING btree ("tenant_id","tool_id","action","scope");--> statement-breakpoint
CREATE INDEX "agent_tool_approvals_status_idx" ON "agent_tool_approvals" USING btree ("tenant_id","status","requested_at");--> statement-breakpoint
CREATE INDEX "agent_tool_runs_tool_idx" ON "agent_tool_runs" USING btree ("tenant_id","tool_id","started_at");

ALTER TABLE agent_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tools FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_tools;
CREATE POLICY tenant_isolation ON agent_tools
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE agent_tool_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tool_approvals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_tool_approvals;
CREATE POLICY tenant_isolation ON agent_tool_approvals
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE agent_tool_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tool_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_tool_runs;
CREATE POLICY tenant_isolation ON agent_tool_runs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
