CREATE TYPE "public"."assignment_status" AS ENUM('pending', 'working', 'waiting_approval', 'delivered', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"source" jsonb NOT NULL,
	"title" text NOT NULL,
	"spec" text NOT NULL,
	"formats" text[] DEFAULT '{}' NOT NULL,
	"deliver_to" jsonb NOT NULL,
	"due_at" timestamp with time zone,
	"status" "assignment_status" DEFAULT 'pending' NOT NULL,
	"run_id" uuid,
	"result_file_ids" uuid[] DEFAULT '{}' NOT NULL,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE INDEX "assignments_person_idx" ON "assignments" USING btree ("tenant_id","person_id","created_at");--> statement-breakpoint
CREATE INDEX "assignments_status_idx" ON "assignments" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "transcript" jsonb;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "executed_at" timestamp with time zone;

ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON assignments;
CREATE POLICY tenant_isolation ON assignments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Decisions acted on under the old executor (which completed the run) must not
-- be re-executed by the new claim-by-null-executed_at pass.
UPDATE approvals SET executed_at = decided_at WHERE status IN ('approved', 'rejected') AND executed_at IS NULL;
