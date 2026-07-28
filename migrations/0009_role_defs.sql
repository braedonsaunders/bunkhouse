CREATE TABLE "role_defs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"pitch" text NOT NULL,
	"description" text NOT NULL,
	"personality" jsonb NOT NULL,
	"duties" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"procedures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"autonomy_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"inbound_policy" "inbound_policy" DEFAULT 'staff_only' NOT NULL,
	"suggested_salary_usd" integer DEFAULT 50 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "role_defs_tenant_slug_key" ON "role_defs" USING btree ("tenant_id","slug");
ALTER TABLE role_defs ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_defs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON role_defs;
DROP POLICY IF EXISTS tenant_write_insert ON role_defs;
DROP POLICY IF EXISTS tenant_write_update ON role_defs;
DROP POLICY IF EXISTS tenant_write_delete ON role_defs;
CREATE POLICY tenant_isolation ON role_defs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

