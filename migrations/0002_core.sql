CREATE TYPE "public"."person_kind" AS ENUM('human', 'hand');--> statement-breakpoint
CREATE TYPE "public"."person_status" AS ENUM('onboarding', 'active', 'offboarded');--> statement-breakpoint
CREATE TYPE "public"."proactivity_mode" AS ENUM('reactive', 'duties', 'autonomous');--> statement-breakpoint
CREATE TYPE "public"."mail_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."mailbox_provider" AS ENUM('gmail', 'microsoft', 'imap');--> statement-breakpoint
CREATE TYPE "public"."mailbox_status" AS ENUM('connecting', 'active', 'error', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."procedure_status" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."memory_scope" AS ENUM('hand', 'company');--> statement-breakpoint
CREATE TYPE "public"."memory_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."duty_schedule_kind" AS ENUM('cron', 'interval');--> statement-breakpoint
CREATE TYPE "public"."run_event_kind" AS ENUM('thought', 'message', 'tool_call', 'tool_result', 'procedure_citation', 'approval_request', 'delegation', 'error');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'waiting_approval', 'waiting_reply', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."action_category" AS ENUM('external_email', 'internal_email', 'record_write', 'money_adjacent', 'file_write', 'computer_use', 'shell');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."autonomy_level" AS ENUM('forbidden', 'approval', 'notify', 'trusted');--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "person_kind" NOT NULL,
	"status" "person_status" DEFAULT 'onboarding' NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"timezone" text,
	"responsibilities" text,
	"reports_to_id" uuid,
	"user_id" uuid,
	"avatar_file_id" uuid,
	"role_pack_slug" text,
	"personality" jsonb,
	"model_config" jsonb,
	"salary" jsonb,
	"proactivity" "proactivity_mode" DEFAULT 'duties',
	"started_on" date,
	"ended_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "mail_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"direction" "mail_direction" NOT NULL,
	"from" jsonb NOT NULL,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"body_html" text,
	"external_message_id" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"run_id" uuid,
	"sent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "mail_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"external_thread_key" text,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL,
	"open" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "mailbox_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"address" text NOT NULL,
	"provider" "mailbox_provider" NOT NULL,
	"status" "mailbox_status" DEFAULT 'connecting' NOT NULL,
	"imap" jsonb,
	"secret_ref" text NOT NULL,
	"sync_cursor" jsonb,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "procedure_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"procedure_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"change_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "procedures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"status" "procedure_status" DEFAULT 'draft' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"assignment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" jsonb DEFAULT '{"type":"authored"}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope" "memory_scope" NOT NULL,
	"person_id" uuid,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" "memory_status" DEFAULT 'active' NOT NULL,
	"source_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "duties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"instruction" text NOT NULL,
	"schedule_kind" "duty_schedule_kind" NOT NULL,
	"schedule" text NOT NULL,
	"from_role_pack_duty" text,
	"enabled" text DEFAULT 'on' NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" "run_event_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"trigger" jsonb NOT NULL,
	"summary" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "token_spend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cost_usd" numeric(19, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"category" "action_category" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"decided_by_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "autonomy_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"category" "action_category" NOT NULL,
	"level" "autonomy_level" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_reports_to_fk" FOREIGN KEY ("reports_to_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "people_tenant_email_key" ON "people" USING btree ("tenant_id",lower("email"));--> statement-breakpoint
CREATE INDEX "people_tenant_kind_idx" ON "people" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE INDEX "mail_messages_thread_idx" ON "mail_messages" USING btree ("tenant_id","thread_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_messages_external_id_key" ON "mail_messages" USING btree ("thread_id","external_message_id");--> statement-breakpoint
CREATE INDEX "mail_threads_mailbox_idx" ON "mail_threads" USING btree ("tenant_id","mailbox_id","last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_threads_external_key" ON "mail_threads" USING btree ("mailbox_id","external_thread_key");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_accounts_tenant_address_key" ON "mailbox_accounts" USING btree ("tenant_id","address");--> statement-breakpoint
CREATE INDEX "mailbox_accounts_person_idx" ON "mailbox_accounts" USING btree ("tenant_id","person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "procedure_revisions_version_key" ON "procedure_revisions" USING btree ("procedure_id","version");--> statement-breakpoint
CREATE INDEX "procedure_revisions_tenant_idx" ON "procedure_revisions" USING btree ("tenant_id","procedure_id");--> statement-breakpoint
CREATE UNIQUE INDEX "procedures_tenant_slug_key" ON "procedures" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "memories_scope_slug_key" ON "memories" USING btree ("tenant_id","scope","person_id","slug");--> statement-breakpoint
CREATE INDEX "memories_person_idx" ON "memories" USING btree ("tenant_id","person_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "duties_person_slug_key" ON "duties" USING btree ("tenant_id","person_id","slug");--> statement-breakpoint
CREATE INDEX "duties_due_idx" ON "duties" USING btree ("tenant_id","next_due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_seq_key" ON "run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "runs_person_idx" ON "runs" USING btree ("tenant_id","person_id","started_at");--> statement-breakpoint
CREATE INDEX "token_spend_person_idx" ON "token_spend" USING btree ("tenant_id","person_id","created_at");--> statement-breakpoint
CREATE INDEX "approvals_pending_idx" ON "approvals" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "autonomy_settings_key" ON "autonomy_settings" USING btree ("tenant_id","person_id","category");