-- Conversation uploads are first written to a lifecycle-managed pending
-- object, verified by the server, and promoted into the immutable files
-- ledger. A queued turn keeps its exact ordered file set in an append-only
-- relation so retries and process recovery cannot reinterpret its input.
CREATE TYPE "public"."chat_file_upload_status" AS ENUM('pending', 'finalized', 'failed');--> statement-breakpoint

CREATE TABLE "chat_file_uploads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "thread_id" uuid NOT NULL,
  "person_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "filename" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "pending_storage_key" text NOT NULL,
  "final_storage_key" text NOT NULL,
  "multipart_upload_id" text,
  "status" "chat_file_upload_status" DEFAULT 'pending' NOT NULL,
  "file_id" uuid,
  "expires_at" timestamp with time zone NOT NULL,
  "finalized_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid,
  CONSTRAINT "chat_file_uploads_size_check" CHECK ("size_bytes" > 0 AND "size_bytes" <= 20971520)
);--> statement-breakpoint

CREATE TABLE "chat_dispatch_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "dispatch_id" uuid NOT NULL,
  "file_id" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  CONSTRAINT "chat_dispatch_attachments_ordinal_check" CHECK ("ordinal" >= 0)
);--> statement-breakpoint

CREATE INDEX "chat_file_uploads_owner_idx" ON "chat_file_uploads" ("tenant_id", "user_id", "thread_id", "created_at");--> statement-breakpoint
CREATE INDEX "chat_file_uploads_expiry_idx" ON "chat_file_uploads" ("status", "expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_dispatch_attachments_file_key" ON "chat_dispatch_attachments" ("dispatch_id", "file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_dispatch_attachments_ordinal_key" ON "chat_dispatch_attachments" ("dispatch_id", "ordinal");--> statement-breakpoint
CREATE INDEX "chat_dispatch_attachments_tenant_idx" ON "chat_dispatch_attachments" ("tenant_id", "dispatch_id", "ordinal");--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_chat_file_upload_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
    OR NEW.thread_id <> OLD.thread_id
    OR NEW.person_id <> OLD.person_id
    OR NEW.user_id <> OLD.user_id
    OR NEW.filename <> OLD.filename
    OR NEW.content_type <> OLD.content_type
    OR NEW.size_bytes <> OLD.size_bytes
    OR NEW.pending_storage_key <> OLD.pending_storage_key
    OR NEW.final_storage_key <> OLD.final_storage_key
    OR NEW.multipart_upload_id IS DISTINCT FROM OLD.multipart_upload_id
    OR NEW.expires_at <> OLD.expires_at
    OR NEW.created_at <> OLD.created_at
    OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'chat upload identity is immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'pending' AND NEW.status IN ('finalized', 'failed')) THEN
    RAISE EXCEPTION 'invalid chat upload transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'finalized' AND (NEW.file_id IS NULL OR NEW.finalized_at IS NULL) THEN
    RAISE EXCEPTION 'finalized chat upload requires its file record';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER chat_file_uploads_state_machine
BEFORE UPDATE ON chat_file_uploads
FOR EACH ROW EXECUTE FUNCTION enforce_chat_file_upload_change();--> statement-breakpoint

CREATE TRIGGER chat_dispatch_attachments_immutable
BEFORE UPDATE OR DELETE ON chat_dispatch_attachments
FOR EACH ROW EXECUTE FUNCTION reject_immutable_ledger_change();--> statement-breakpoint

ALTER TABLE chat_file_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_file_uploads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_file_uploads
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE chat_dispatch_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_dispatch_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_dispatch_attachments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
