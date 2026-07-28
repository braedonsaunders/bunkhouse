CREATE TYPE "public"."chat_provider" AS ENUM('slack', 'teams');--> statement-breakpoint
CREATE TABLE "chat_channel_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" "chat_provider" NOT NULL,
	"channel_id" text NOT NULL,
	"channel_label" text,
	"person_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_channel_routes_key" ON "chat_channel_routes" USING btree ("tenant_id","provider","channel_id");--> statement-breakpoint
CREATE INDEX "chat_channel_routes_person_idx" ON "chat_channel_routes" USING btree ("tenant_id","person_id");--> statement-breakpoint

CREATE TABLE "chat_inbound_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" "chat_provider" NOT NULL,
	"event_id" text NOT NULL,
	"person_id" uuid,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_inbound_events_key" ON "chat_inbound_events" USING btree ("tenant_id","provider","event_id");--> statement-breakpoint

ALTER TABLE chat_channel_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_channel_routes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON chat_channel_routes;
CREATE POLICY tenant_isolation ON chat_channel_routes
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE chat_inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_inbound_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON chat_inbound_events;
CREATE POLICY tenant_isolation ON chat_inbound_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
