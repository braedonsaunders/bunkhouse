CREATE TYPE "remote_computer_status" AS ENUM('ready', 'unreachable', 'disabled');--> statement-breakpoint
CREATE TYPE "remote_session_status" AS ENUM('opening', 'connected', 'idle', 'closed', 'failed');--> statement-breakpoint

CREATE TABLE "remote_computers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "name" text NOT NULL,
  "host" text NOT NULL,
  "port" integer NOT NULL,
  "protocol" text NOT NULL,
  "provider" text DEFAULT 'steward' NOT NULL,
  "provider_base_url" text NOT NULL,
  "provider_target_id" text NOT NULL,
  "sealed_provider_token" jsonb,
  "status" "remote_computer_status" DEFAULT 'ready' NOT NULL,
  "last_connected_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  "updated_by" uuid
);--> statement-breakpoint

CREATE TABLE "remote_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "computer_id" uuid NOT NULL,
  "person_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "protocol" text NOT NULL,
  "status" "remote_session_status" DEFAULT 'opening' NOT NULL,
  "provider_session_id" text,
  "opened_at" timestamp with time zone DEFAULT now() NOT NULL,
  "connected_at" timestamp with time zone,
  "closed_at" timestamp with time zone,
  "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "event_seq" integer DEFAULT 0 NOT NULL,
  "lease_fence" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  "updated_by" uuid
);--> statement-breakpoint

CREATE TABLE "remote_session_leases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "holder" text NOT NULL,
  "purpose" text NOT NULL,
  "scope" text NOT NULL,
  "exclusive" integer DEFAULT 0 NOT NULL,
  "fence" integer NOT NULL,
  "granted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "remote_session_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "seq" integer NOT NULL,
  "kind" text NOT NULL,
  "detail" jsonb NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX "remote_computers_provider_target_ux" ON "remote_computers" ("tenant_id", "provider", "provider_target_id");--> statement-breakpoint
CREATE INDEX "remote_computers_status_idx" ON "remote_computers" ("tenant_id", "status", "name");--> statement-breakpoint
CREATE INDEX "remote_sessions_run_idx" ON "remote_sessions" ("tenant_id", "run_id", "opened_at");--> statement-breakpoint
CREATE INDEX "remote_sessions_person_idx" ON "remote_sessions" ("tenant_id", "person_id", "opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "remote_session_leases_fence_ux" ON "remote_session_leases" ("session_id", "fence");--> statement-breakpoint
CREATE INDEX "remote_session_leases_session_idx" ON "remote_session_leases" ("tenant_id", "session_id", "expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "remote_session_events_seq_ux" ON "remote_session_events" ("session_id", "seq");--> statement-breakpoint
CREATE INDEX "remote_session_events_session_idx" ON "remote_session_events" ("tenant_id", "session_id", "at");--> statement-breakpoint

ALTER TABLE "remote_computers" ADD CONSTRAINT "remote_computers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_computer_id_remote_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."remote_computers"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "remote_session_leases" ADD CONSTRAINT "remote_session_leases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "remote_session_leases" ADD CONSTRAINT "remote_session_leases_session_id_remote_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."remote_sessions"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "remote_session_events" ADD CONSTRAINT "remote_session_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "remote_session_events" ADD CONSTRAINT "remote_session_events_session_id_remote_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."remote_sessions"("id") ON DELETE restrict;--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_immutable_remote_history_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER remote_session_leases_immutable BEFORE UPDATE OR DELETE ON remote_session_leases FOR EACH ROW EXECUTE FUNCTION reject_immutable_remote_history_change();--> statement-breakpoint
CREATE TRIGGER remote_session_events_immutable BEFORE UPDATE OR DELETE ON remote_session_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_remote_history_change();--> statement-breakpoint

ALTER TABLE remote_computers ENABLE ROW LEVEL SECURITY; ALTER TABLE remote_computers FORCE ROW LEVEL SECURITY; CREATE POLICY tenant_isolation ON remote_computers USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
ALTER TABLE remote_sessions ENABLE ROW LEVEL SECURITY; ALTER TABLE remote_sessions FORCE ROW LEVEL SECURITY; CREATE POLICY tenant_isolation ON remote_sessions USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
ALTER TABLE remote_session_leases ENABLE ROW LEVEL SECURITY; ALTER TABLE remote_session_leases FORCE ROW LEVEL SECURITY; CREATE POLICY tenant_isolation ON remote_session_leases USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
ALTER TABLE remote_session_events ENABLE ROW LEVEL SECURITY; ALTER TABLE remote_session_events FORCE ROW LEVEL SECURITY; CREATE POLICY tenant_isolation ON remote_session_events USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
