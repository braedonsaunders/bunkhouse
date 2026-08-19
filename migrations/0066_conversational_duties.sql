-- Preserve the request that caused an employee to create a scheduled duty.
-- `created_by` says whose hand wrote it; `source_run_id` says whether that hand
-- was answering a person or acting on its own.
ALTER TABLE "duties" ADD COLUMN "source_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "duties" ADD CONSTRAINT "duties_source_run_fk"
  FOREIGN KEY ("source_run_id") REFERENCES "runs"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "duties_source_run_idx" ON "duties" ("tenant_id", "source_run_id");
