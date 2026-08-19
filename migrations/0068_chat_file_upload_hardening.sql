-- Tighten the mutable upload projection after the initial conversation-file
-- cutover without rewriting its already-applied migration.
CREATE UNIQUE INDEX "chat_file_uploads_file_key" ON "chat_file_uploads" ("file_id");--> statement-breakpoint

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
  IF NEW.status = 'pending' AND (
    NEW.file_id IS DISTINCT FROM OLD.file_id OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at
  ) THEN
    RAISE EXCEPTION 'pending chat upload cannot claim a finalized file';
  END IF;
  IF NEW.status = 'failed' AND (NEW.file_id IS NOT NULL OR NEW.finalized_at IS NOT NULL) THEN
    RAISE EXCEPTION 'failed chat upload cannot claim a finalized file';
  END IF;
  RETURN NEW;
END;
$$;
