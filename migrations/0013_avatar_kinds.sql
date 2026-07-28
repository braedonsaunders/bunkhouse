CREATE TYPE "public"."avatar_kind" AS ENUM('portrait', 'full_body');--> statement-breakpoint
DROP INDEX "avatar_images_person_ux";--> statement-breakpoint
ALTER TABLE "avatar_images" ADD COLUMN "kind" "avatar_kind" DEFAULT 'portrait' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "avatar_images_person_kind_ux" ON "avatar_images" USING btree ("tenant_id","person_id","kind");