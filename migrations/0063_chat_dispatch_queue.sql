-- Durable, per-conversation dispatch. A message is first accepted as intent,
-- then claimed in stable FIFO order. One running row per thread is enforced by
-- the database, not by process-local promises. The mutable row is only the
-- claim projection; every transition and edit is preserved in the immutable
-- event ledger below it.
CREATE TYPE "public"."chat_dispatch_status" AS ENUM('queued', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."chat_dispatch_event_kind" AS ENUM('queued', 'claimed', 'run_linked', 'completed', 'failed', 'retried', 'edited', 'cancelled');--> statement-breakpoint

CREATE TABLE "chat_dispatches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "thread_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "position" integer NOT NULL,
  "idempotency_key" text NOT NULL,
  "body" text NOT NULL,
  "status" "chat_dispatch_status" DEFAULT 'queued' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "run_id" uuid,
  "last_error" text,
  "queued_at" timestamp with time zone DEFAULT now() NOT NULL,
  "claimed_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid,
  CONSTRAINT "chat_dispatches_position_check" CHECK ("position" >= 0),
  CONSTRAINT "chat_dispatches_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "chat_dispatches_body_check" CHECK (length(btrim("body")) > 0)
);--> statement-breakpoint

CREATE TABLE "chat_dispatch_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "dispatch_id" uuid NOT NULL,
  "seq" integer NOT NULL,
  "kind" "chat_dispatch_event_kind" NOT NULL,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "actor_id" uuid,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "chat_messages" ADD COLUMN "dispatch_id" uuid;--> statement-breakpoint

CREATE UNIQUE INDEX "chat_dispatches_idempotency_key" ON "chat_dispatches" ("thread_id", "idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_dispatches_position_key" ON "chat_dispatches" ("thread_id", "position");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_dispatches_one_running_key" ON "chat_dispatches" ("thread_id") WHERE "status" = 'running';--> statement-breakpoint
CREATE INDEX "chat_dispatches_pending_idx" ON "chat_dispatches" ("tenant_id", "thread_id", "position");--> statement-breakpoint
CREATE INDEX "chat_dispatches_run_idx" ON "chat_dispatches" ("tenant_id", "run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_dispatch_events_seq_key" ON "chat_dispatch_events" ("dispatch_id", "seq");--> statement-breakpoint
CREATE INDEX "chat_dispatch_events_tenant_idx" ON "chat_dispatch_events" ("tenant_id", "dispatch_id", "seq");--> statement-breakpoint
CREATE INDEX "chat_messages_dispatch_idx" ON "chat_messages" ("tenant_id", "dispatch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_dispatch_user_key" ON "chat_messages" ("dispatch_id") WHERE "role" = 'user' AND "dispatch_id" IS NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_chat_dispatch_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
    OR NEW.thread_id <> OLD.thread_id
    OR NEW.user_id <> OLD.user_id
    OR NEW.position <> OLD.position
    OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.queued_at <> OLD.queued_at
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'chat dispatch identity and FIFO position are immutable';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'queued' AND NEW.status IN ('running', 'cancelled')) OR
    (OLD.status = 'running' AND NEW.status IN ('completed', 'failed')) OR
    (OLD.status = 'failed' AND NEW.status IN ('queued', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'invalid chat dispatch transition: % -> %', OLD.status, NEW.status;
  END IF;

  IF NEW.body <> OLD.body AND OLD.status NOT IN ('queued', 'failed') THEN
    RAISE EXCEPTION 'only queued or failed chat dispatches may be edited';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER chat_dispatches_state_machine
BEFORE UPDATE ON chat_dispatches
FOR EACH ROW EXECUTE FUNCTION enforce_chat_dispatch_change();--> statement-breakpoint

CREATE TRIGGER chat_dispatch_events_immutable
BEFORE UPDATE OR DELETE ON chat_dispatch_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_ledger_change();--> statement-breakpoint

ALTER TABLE chat_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_dispatches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_dispatches
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE chat_dispatch_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_dispatch_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_dispatch_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
