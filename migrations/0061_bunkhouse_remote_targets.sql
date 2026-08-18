DROP INDEX IF EXISTS "remote_computers_provider_target_ux";--> statement-breakpoint

ALTER TABLE "remote_computers" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "remote_computers" ADD COLUMN "domain" text;--> statement-breakpoint
ALTER TABLE "remote_computers" ADD COLUMN "credential_kind" text DEFAULT 'password' NOT NULL;--> statement-breakpoint
ALTER TABLE "remote_computers" ADD COLUMN "sealed_credential" jsonb;--> statement-breakpoint

UPDATE "remote_computers"
SET "status" = 'unreachable',
    "last_error" = 'Re-enter this computer credential in Library → Computers to use the Bunkhouse remote gateway.',
    "updated_at" = now()
WHERE "provider" = 'steward';--> statement-breakpoint

ALTER TABLE "remote_computers" DROP COLUMN "provider";--> statement-breakpoint
ALTER TABLE "remote_computers" DROP COLUMN "provider_base_url";--> statement-breakpoint
ALTER TABLE "remote_computers" DROP COLUMN "provider_target_id";--> statement-breakpoint
ALTER TABLE "remote_computers" DROP COLUMN "sealed_provider_token";--> statement-breakpoint

CREATE UNIQUE INDEX "remote_computers_target_ux"
  ON "remote_computers" ("tenant_id", "protocol", "host", "port", "name");
