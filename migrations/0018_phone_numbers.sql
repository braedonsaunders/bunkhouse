-- Real phone numbers agents answer.
--
-- A tenant reaches its agents by phone one of two ways, and both are SIP
-- trunks into the LiveKit ingress: a PBX routes an extension range (agents
-- answer on people.extension), or a carrier (Twilio, Telnyx, a hosted DID)
-- delivers a provisioned number with the dialed number as the callee. This
-- table is the second path's routing: dialed number → the agent who picks up.
-- Numbers are stored as bare E.164 digits (no '+') — the one shape every
-- carrier's callee header normalizes to.

CREATE TABLE "phone_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"label" text NOT NULL,
	"person_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE INDEX "phone_numbers_tenant_idx" ON "phone_numbers" USING btree ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "phone_numbers_tenant_number_key" ON "phone_numbers" USING btree ("tenant_id","number");
--> statement-breakpoint
ALTER TABLE phone_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE phone_numbers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON phone_numbers;
CREATE POLICY tenant_isolation ON phone_numbers
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
