CREATE TABLE "tenant_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_settings_key_ux" ON "tenant_settings" USING btree ("tenant_id","key");
ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_settings;
DROP POLICY IF EXISTS tenant_write_insert ON tenant_settings;
DROP POLICY IF EXISTS tenant_write_update ON tenant_settings;
DROP POLICY IF EXISTS tenant_write_delete ON tenant_settings;
CREATE POLICY tenant_isolation ON tenant_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

