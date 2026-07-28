CREATE TYPE "public"."document_template_kind" AS ENUM('document', 'spreadsheet');--> statement-breakpoint
CREATE TYPE "public"."document_template_format" AS ENUM('docx', 'pdf');--> statement-breakpoint
CREATE TYPE "public"."document_template_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."filing_provider" AS ENUM('google_drive', 'onedrive', 'smb');--> statement-breakpoint
CREATE TYPE "public"."filing_status" AS ENUM('filed', 'failed');--> statement-breakpoint
CREATE TABLE "document_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" "document_template_kind" NOT NULL,
	"body" text NOT NULL,
	"default_format" "document_template_format" DEFAULT 'docx' NOT NULL,
	"merge_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "document_template_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "file_filings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"provider" "filing_provider" NOT NULL,
	"status" "filing_status" NOT NULL,
	"location" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "document_templates_slug_ux" ON "document_templates" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "document_templates_status_idx" ON "document_templates" USING btree ("tenant_id","status","name");--> statement-breakpoint
CREATE INDEX "file_filings_recent_idx" ON "file_filings" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "file_filings_file_idx" ON "file_filings" USING btree ("tenant_id","file_id");

ALTER TABLE document_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON document_templates;
CREATE POLICY tenant_isolation ON document_templates
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE file_filings ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_filings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON file_filings;
CREATE POLICY tenant_isolation ON file_filings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
