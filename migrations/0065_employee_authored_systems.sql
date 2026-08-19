CREATE TYPE "public"."authored_system_status" AS ENUM ('proposed', 'active', 'disabled');
--> statement-breakpoint
CREATE TYPE "public"."authored_system_health_status" AS ENUM ('ok', 'failed');
--> statement-breakpoint

CREATE TABLE "authored_systems" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "status" "authored_system_status" DEFAULT 'proposed' NOT NULL,
  "latest_version" integer DEFAULT 1 NOT NULL,
  "active_version" integer,
  "assignment" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "proposed_by_person_id" uuid,
  "proposed_by_run_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid,
  CONSTRAINT "authored_systems_version_ck" CHECK (
    "latest_version" > 0 AND ("active_version" IS NULL OR ("active_version" > 0 AND "active_version" <= "latest_version"))
  )
);
--> statement-breakpoint

CREATE TABLE "authored_system_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "system_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "definition" jsonb NOT NULL,
  "validation" jsonb NOT NULL,
  "change_note" text,
  "proposed_by_person_id" uuid,
  "proposed_by_run_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid,
  CONSTRAINT "authored_system_revisions_version_ck" CHECK ("version" > 0)
);
--> statement-breakpoint

CREATE TABLE "authored_system_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "system_id" uuid NOT NULL,
  "sealed_credential" jsonb,
  "health_status" "authored_system_health_status",
  "last_checked_at" timestamp with time zone,
  "last_error" text,
  "last_tool_count" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid
);
--> statement-breakpoint

CREATE UNIQUE INDEX "authored_systems_tenant_slug_ux" ON "authored_systems" ("tenant_id", "slug");
--> statement-breakpoint
CREATE UNIQUE INDEX "authored_systems_tenant_id_ux" ON "authored_systems" ("tenant_id", "id");
--> statement-breakpoint
CREATE INDEX "authored_systems_tenant_status_idx" ON "authored_systems" ("tenant_id", "status", "name");
--> statement-breakpoint
CREATE UNIQUE INDEX "authored_system_revisions_version_ux" ON "authored_system_revisions" ("system_id", "version");
--> statement-breakpoint
CREATE INDEX "authored_system_revisions_tenant_system_idx" ON "authored_system_revisions" ("tenant_id", "system_id", "version");
--> statement-breakpoint
CREATE UNIQUE INDEX "authored_system_connections_system_ux" ON "authored_system_connections" ("system_id");
--> statement-breakpoint
CREATE INDEX "authored_system_connections_tenant_health_idx" ON "authored_system_connections" ("tenant_id", "health_status");
--> statement-breakpoint

ALTER TABLE "authored_systems" ADD CONSTRAINT "authored_systems_tenant_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "authored_system_revisions" ADD CONSTRAINT "authored_system_revisions_tenant_system_fk"
  FOREIGN KEY ("tenant_id", "system_id") REFERENCES "authored_systems"("tenant_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "authored_system_connections" ADD CONSTRAINT "authored_system_connections_tenant_system_fk"
  FOREIGN KEY ("tenant_id", "system_id") REFERENCES "authored_systems"("tenant_id", "id") ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE "authored_systems" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "authored_systems" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "authored_systems"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "authored_system_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "authored_system_revisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "authored_system_revisions"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "authored_system_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "authored_system_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "authored_system_connections"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
