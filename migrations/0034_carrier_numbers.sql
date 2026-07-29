-- Carrier numbers, in both directions.
--
-- Two facts were missing once a real phone number entered the picture.
--
-- A trunk never said what it carries, so dialing out picked whichever line came
-- first: a company running a PBX alongside a carrier sent half its calls down
-- the wrong one. dial_scope is that fact — internal extensions, outside
-- numbers, or both, which is what every existing line already is.
--
-- And a provisioned number was inbound routing only. Nothing presented it as
-- caller id when an agent dialed out, so the From on a carrier leg was the
-- agent's internal extension — a number the carrier has never heard of and
-- rejects. phone_numbers now records which trunk carries a number and who
-- provisioned it, so a call out can present the number the caller answers on,
-- and a number bought in-app can be handed back to the carrier when it is
-- released rather than merely forgotten here.

CREATE TYPE "public"."sip_dial_scope" AS ENUM('internal', 'external', 'both');
--> statement-breakpoint
CREATE TYPE "public"."phone_number_provider" AS ENUM('manual', 'twilio');
--> statement-breakpoint
ALTER TABLE "sip_trunks" ADD COLUMN "dial_scope" "public"."sip_dial_scope" DEFAULT 'both' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sip_trunks" ADD COLUMN "caller_id" text;
--> statement-breakpoint
ALTER TABLE "sip_trunks" ADD COLUMN "carrier_trunk_sid" text;
--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD COLUMN "trunk_id" uuid;
--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD COLUMN "provider" "public"."phone_number_provider" DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD COLUMN "provider_sid" text;
--> statement-breakpoint
CREATE INDEX "phone_numbers_person_idx" ON "phone_numbers" USING btree ("tenant_id","person_id");
