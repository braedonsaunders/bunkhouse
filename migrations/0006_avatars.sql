CREATE TABLE "avatar_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"data" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "avatar_images_person_ux" ON "avatar_images" USING btree ("tenant_id","person_id");
ALTER TABLE avatar_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE avatar_images FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON avatar_images;
DROP POLICY IF EXISTS tenant_write_insert ON avatar_images;
DROP POLICY IF EXISTS tenant_write_update ON avatar_images;
DROP POLICY IF EXISTS tenant_write_delete ON avatar_images;
CREATE POLICY tenant_isolation ON avatar_images
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

