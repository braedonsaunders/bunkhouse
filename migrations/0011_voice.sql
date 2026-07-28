CREATE TYPE "public"."call_direction" AS ENUM('web', 'inbound_phone', 'outbound_phone');--> statement-breakpoint
CREATE TYPE "public"."call_session_status" AS ENUM('active', 'ended', 'failed');--> statement-breakpoint
CREATE TYPE "public"."call_speaker" AS ENUM('hand', 'human');--> statement-breakpoint
CREATE TABLE "call_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"run_id" uuid,
	"room" text NOT NULL,
	"direction" "call_direction" NOT NULL,
	"counterparty" jsonb NOT NULL,
	"status" "call_session_status" DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"cost_usd" numeric(19, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "call_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"speaker" "call_speaker" NOT NULL,
	"text" text NOT NULL,
	"at_ms" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "voice_config" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "call_sessions_room_key" ON "call_sessions" USING btree ("room");--> statement-breakpoint
CREATE INDEX "call_sessions_person_idx" ON "call_sessions" USING btree ("tenant_id","person_id","started_at");--> statement-breakpoint
CREATE INDEX "call_sessions_run_idx" ON "call_sessions" USING btree ("tenant_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "call_turns_seq_key" ON "call_turns" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "call_turns_session_idx" ON "call_turns" USING btree ("tenant_id","session_id");

ALTER TABLE call_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON call_sessions;
DROP POLICY IF EXISTS tenant_write_insert ON call_sessions;
DROP POLICY IF EXISTS tenant_write_update ON call_sessions;
DROP POLICY IF EXISTS tenant_write_delete ON call_sessions;
CREATE POLICY tenant_isolation ON call_sessions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE call_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_turns FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON call_turns;
DROP POLICY IF EXISTS tenant_write_insert ON call_turns;
DROP POLICY IF EXISTS tenant_write_update ON call_turns;
DROP POLICY IF EXISTS tenant_write_delete ON call_turns;
CREATE POLICY tenant_isolation ON call_turns
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
