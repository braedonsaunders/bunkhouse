-- A continuation is a new conversation with an immutable branch point. Old
-- messages are never copied or edited; the child can inherit context through
-- the recorded message sequence while all later runs belong to the child.
ALTER TABLE "chat_threads" ADD COLUMN "origin_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "origin_message_seq" integer;--> statement-breakpoint

ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_origin_pair_check"
  CHECK (("origin_thread_id" IS NULL) = ("origin_message_seq" IS NULL));--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_origin_seq_check"
  CHECK ("origin_message_seq" IS NULL OR "origin_message_seq" >= 0);--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_origin_self_check"
  CHECK ("origin_thread_id" IS NULL OR "origin_thread_id" <> "id");--> statement-breakpoint

CREATE INDEX "chat_threads_origin_idx" ON "chat_threads" ("tenant_id", "origin_thread_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_chat_thread_origin_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origin_thread_id IS DISTINCT FROM OLD.origin_thread_id
    OR NEW.origin_message_seq IS DISTINCT FROM OLD.origin_message_seq THEN
    RAISE EXCEPTION 'chat continuation provenance is immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER chat_threads_origin_immutable
BEFORE UPDATE OF origin_thread_id, origin_message_seq ON chat_threads
FOR EACH ROW EXECUTE FUNCTION enforce_chat_thread_origin_change();
