CREATE TYPE "public"."inbound_policy" AS ENUM('staff_only', 'known_contacts', 'anyone');--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "inbound_policy" "inbound_policy" DEFAULT 'staff_only';