-- Phone system hardening + the registered-extensions bridge.
--
-- Three things land here.
--
-- 1. The call ledger learns who was on the other end of the line: peer_kind
--    ('pstn' | 'pbx_extension' | 'web') and peer_extension. Existing rows are
--    classified from their direction — web calls are 'web', phone calls are
--    'pstn' (the honest reading: before this migration nothing recorded a PBX
--    peer). The column is nullable on purpose: NULL means "not classified",
--    never a guess.
--
-- 2. sip_trunks gains the operator controls the pilot proved necessary:
--    media encryption (SRTP) per trunk, a session timer to match the PBX line
--    (the "calls drop at 15 or 30 minutes" class of fault), a SIP ingress
--    address allowlist, an operator-supplied test extension for the Test call
--    button, and OPTIONS-keepalive health (health, health_detail, last_seen_at).
--
-- 3. pbx_extensions — THE extension map for registered-extension mode: one row
--    per agent endpoint the bridge REGISTERs to the PBX, with sealed
--    per-extension credentials and the registration state scraped back off the
--    bridge. Unique per (trunk, extension); RLS as with every tenant table.

CREATE TYPE "public"."call_peer_kind" AS ENUM('pstn', 'pbx_extension', 'web');--> statement-breakpoint
CREATE TYPE "public"."sip_srtp_mode" AS ENUM('disabled', 'best_effort', 'required');--> statement-breakpoint
CREATE TYPE "public"."sip_trunk_health" AS ENUM('unknown', 'ok', 'unreachable');--> statement-breakpoint
CREATE TYPE "public"."pbx_extension_reg_status" AS ENUM('unregistered', 'registered', 'failed');--> statement-breakpoint
CREATE TABLE "pbx_extensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trunk_id" uuid NOT NULL,
	"extension" text NOT NULL,
	"person_id" uuid NOT NULL,
	"auth_username" text,
	"sealed_auth_password" jsonb,
	"reg_status" "pbx_extension_reg_status" DEFAULT 'unregistered' NOT NULL,
	"reg_expires_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "pbx_extensions" ADD CONSTRAINT "pbx_extensions_trunk_fk" FOREIGN KEY ("trunk_id") REFERENCES "public"."sip_trunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pbx_extensions" ADD CONSTRAINT "pbx_extensions_person_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pbx_extensions_tenant_idx" ON "pbx_extensions" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pbx_extensions_trunk_extension_key" ON "pbx_extensions" USING btree ("trunk_id","extension");--> statement-breakpoint
CREATE INDEX "pbx_extensions_person_idx" ON "pbx_extensions" USING btree ("tenant_id","person_id");--> statement-breakpoint
ALTER TABLE "sip_trunks" ADD COLUMN "srtp" "sip_srtp_mode" DEFAULT 'disabled' NOT NULL;--> statement-breakpoint
ALTER TABLE "sip_trunks" ADD COLUMN "session_timer_seconds" integer;--> statement-breakpoint
ALTER TABLE "sip_trunks" ADD COLUMN "allowed_addresses" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "sip_trunks" ADD COLUMN "test_extension" text;--> statement-breakpoint
ALTER TABLE "sip_trunks" ADD COLUMN "health" "sip_trunk_health" DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "sip_trunks" ADD COLUMN "health_detail" text;--> statement-breakpoint
ALTER TABLE "sip_trunks" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "call_sessions" ADD COLUMN "peer_kind" "call_peer_kind";--> statement-breakpoint
ALTER TABLE "call_sessions" ADD COLUMN "peer_extension" text;--> statement-breakpoint
UPDATE "call_sessions"
   SET "peer_kind" = CASE WHEN "direction" = 'web' THEN 'web'::call_peer_kind ELSE 'pstn'::call_peer_kind END
 WHERE "peer_kind" IS NULL;--> statement-breakpoint
-- The address a trunk already names is the first entry of its own allowlist;
-- an operator adds the PBX's other signalling addresses alongside it.
UPDATE "sip_trunks"
   SET "allowed_addresses" = ARRAY["pbx_host"]::text[]
 WHERE "pbx_host" IS NOT NULL AND "allowed_addresses" = '{}'::text[];

ALTER TABLE pbx_extensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pbx_extensions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pbx_extensions;
CREATE POLICY tenant_isolation ON pbx_extensions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
