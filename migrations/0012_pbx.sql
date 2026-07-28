CREATE TYPE "public"."sip_transport" AS ENUM('udp', 'tcp', 'tls');--> statement-breakpoint
CREATE TYPE "public"."sip_trunk_flavor" AS ENUM('avaya_ip_office', 'generic_sip');--> statement-breakpoint
CREATE TYPE "public"."sip_trunk_mode" AS ENUM('trunk', 'extension');--> statement-breakpoint
CREATE TYPE "public"."sip_trunk_status" AS ENUM('unconfigured', 'active', 'error');--> statement-breakpoint
CREATE TABLE "sip_trunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"flavor" "sip_trunk_flavor" DEFAULT 'generic_sip' NOT NULL,
	"mode" "sip_trunk_mode" DEFAULT 'trunk' NOT NULL,
	"pbx_host" text,
	"pbx_port" integer DEFAULT 5060 NOT NULL,
	"transport" "sip_transport" DEFAULT 'udp' NOT NULL,
	"auth_username" text,
	"sealed_auth_password" jsonb,
	"extension_range" text,
	"status" "sip_trunk_status" DEFAULT 'unconfigured' NOT NULL,
	"last_error" text,
	"livekit_trunk_id" text,
	"livekit_dispatch_rule_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "extension" text;--> statement-breakpoint
CREATE INDEX "sip_trunks_tenant_idx" ON "sip_trunks" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "people_tenant_extension_key" ON "people" USING btree ("tenant_id","extension") WHERE "people"."extension" is not null;
ALTER TABLE sip_trunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE sip_trunks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON sip_trunks;
DROP POLICY IF EXISTS tenant_write_insert ON sip_trunks;
DROP POLICY IF EXISTS tenant_write_update ON sip_trunks;
DROP POLICY IF EXISTS tenant_write_delete ON sip_trunks;
CREATE POLICY tenant_isolation ON sip_trunks
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

