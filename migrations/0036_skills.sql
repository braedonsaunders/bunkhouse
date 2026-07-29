CREATE TYPE "public"."skill_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"status" "skill_status" DEFAULT 'active' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"assignment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" jsonb NOT NULL,
	"license" text,
	"has_scripts" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "skill_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"frontmatter" jsonb NOT NULL,
	"commit_sha" text NOT NULL,
	"change_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "skill_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"path" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"is_script" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "skills_tenant_slug_key" ON "skills" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "skills_tenant_status_idx" ON "skills" USING btree ("tenant_id","status","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_revisions_version_key" ON "skill_revisions" USING btree ("skill_id","version");--> statement-breakpoint
CREATE INDEX "skill_revisions_tenant_idx" ON "skill_revisions" USING btree ("tenant_id","skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_files_path_key" ON "skill_files" USING btree ("skill_id","version","path");--> statement-breakpoint
CREATE INDEX "skill_files_tenant_idx" ON "skill_files" USING btree ("tenant_id","skill_id","version");

ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON skills;
CREATE POLICY tenant_isolation ON skills
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE skill_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON skill_revisions;
CREATE POLICY tenant_isolation ON skill_revisions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE skill_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_files FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON skill_files;
CREATE POLICY tenant_isolation ON skill_files
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
