CREATE TYPE "public"."domain_event_outbox_status" AS ENUM('pending', 'publishing', 'published');
--> statement-breakpoint
CREATE TABLE "tenant_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tenant_user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"scope" jsonb DEFAULT '{"type":"tenant"}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_permission_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tenant_user_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"effect" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_super_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_ip" text,
	"actor_user_agent" text,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"action" text NOT NULL,
	"summary" text,
	"before" jsonb,
	"after" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_event_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"effect_key" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_event_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"dedup_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "domain_event_outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"api_key_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_users_tenant_user_key" ON "tenant_users" USING btree ("tenant_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_key_key" ON "roles" USING btree ("tenant_id","key");
--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants" USING btree ("slug");
--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");
--> statement-breakpoint
CREATE UNIQUE INDEX "domain_event_effects_event_effect_ux" ON "domain_event_effects" USING btree ("tenant_id","event_id","effect_key");
--> statement-breakpoint
CREATE INDEX "domain_event_effects_event_idx" ON "domain_event_effects" USING btree ("tenant_id","event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "domain_event_outbox_tenant_id_id_ux" ON "domain_event_outbox" USING btree ("tenant_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "domain_event_outbox_dedup_key" ON "domain_event_outbox" USING btree ("tenant_id","dedup_key");
--> statement-breakpoint
CREATE INDEX "domain_event_outbox_status_available_idx" ON "domain_event_outbox" USING btree ("status","available_at");
--> statement-breakpoint
CREATE INDEX "domain_event_outbox_status_claimed_idx" ON "domain_event_outbox" USING btree ("status","claimed_at");
--> statement-breakpoint
CREATE INDEX "domain_event_outbox_tenant_subject_idx" ON "domain_event_outbox" USING btree ("tenant_id","subject_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "api_idempotency_key_scope" ON "api_idempotency_keys" USING btree ("api_key_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys" USING btree ("key_hash");
--> statement-breakpoint
CREATE TYPE "public"."tenant_user_status" AS ENUM('active', 'invited', 'suspended');
--> statement-breakpoint
CREATE TYPE "public"."permission_override_effect" AS ENUM('grant', 'deny');
--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('active', 'suspended', 'archived');
--> statement-breakpoint
ALTER TABLE "user_permission_overrides" ALTER COLUMN "effect" SET DATA TYPE permission_override_effect USING "effect"::text::permission_override_effect;
--> statement-breakpoint
ALTER TABLE "tenant_users" ADD COLUMN "locale_override" text;
--> statement-breakpoint
ALTER TABLE "tenant_users" ADD COLUMN "status" "tenant_user_status" DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_users" ADD COLUMN "invited_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tenant_users" ADD COLUMN "invited_by" uuid;
--> statement-breakpoint
ALTER TABLE "tenant_users" ADD COLUMN "joined_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "role_assignments" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "role_assignments" ADD COLUMN "created_by" uuid;
--> statement-breakpoint
ALTER TABLE "role_assignments" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "role_assignments" ADD COLUMN "updated_by" uuid;
--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "description" text;
--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "is_built_in" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "status" "tenant_status" DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "default_locale" text DEFAULT 'en' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "enabled_locales" jsonb DEFAULT '["en"]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_permission_overrides" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_permission_overrides" ADD COLUMN "created_by" uuid;
--> statement-breakpoint
ALTER TABLE "user_permission_overrides" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_permission_overrides" ADD COLUMN "updated_by" uuid;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "image" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_users_tenant_id_id_key" ON "tenant_users" USING btree ("tenant_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_id_id_key" ON "roles" USING btree ("tenant_id","id");
--> statement-breakpoint
CREATE INDEX "tenant_users_tenant_idx" ON "tenant_users" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "tenant_users_user_idx" ON "tenant_users" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "role_assignments_tenant_member_role_key" ON "role_assignments" USING btree ("tenant_id","tenant_user_id","role_id");
--> statement-breakpoint
CREATE INDEX "role_assignments_tenant_idx" ON "role_assignments" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "role_assignments_member_idx" ON "role_assignments" USING btree ("tenant_user_id");
--> statement-breakpoint
CREATE INDEX "role_assignments_role_idx" ON "role_assignments" USING btree ("role_id");
--> statement-breakpoint
CREATE INDEX "roles_tenant_idx" ON "roles" USING btree ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "user_permission_overrides_member_permission_key" ON "user_permission_overrides" USING btree ("tenant_user_id","permission");
--> statement-breakpoint
CREATE INDEX "user_permission_overrides_tenant_idx" ON "user_permission_overrides" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "user_permission_overrides_member_idx" ON "user_permission_overrides" USING btree ("tenant_user_id");
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"active_tenant_id" uuid,
	"impersonating_user_id" uuid,
	"impersonation_tenant_id" uuid,
	"impersonation_started_at" timestamp with time zone,
	"impersonation_expires_at" timestamp with time zone,
	"impersonation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_account_key" ON "accounts" USING btree ("provider_id","account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions" USING btree ("token");
--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "password_hash";
--> statement-breakpoint
ALTER TABLE "domain_event_effects" ADD CONSTRAINT "domain_event_effects_tenant_event_fk" FOREIGN KEY ("tenant_id","event_id") REFERENCES "public"."domain_event_outbox"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_tenant_member_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_tenant_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "public"."roles"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_tenant_member_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_impersonating_user_id_users_id_fk" FOREIGN KEY ("impersonating_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
