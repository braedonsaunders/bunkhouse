-- A credential request is a real suspension point, just like an approval.
-- Supplying it must wake the employee exactly once, survive a web/worker
-- crash, and deliver the resulting answer into the same conversation.
ALTER TYPE "public"."run_status" ADD VALUE IF NOT EXISTS 'waiting_credential' AFTER 'waiting_reply';--> statement-breakpoint

ALTER TABLE "authored_system_credential_requests"
  ADD COLUMN "continuation_status" text DEFAULT 'pending' NOT NULL,
  ADD COLUMN "continuation_attempts" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "continuation_lease_until" timestamp with time zone,
  ADD COLUMN "continuation_error" text,
  ADD COLUMN "continued_run_id" uuid,
  ADD COLUMN "continued_at" timestamp with time zone,
  ADD CONSTRAINT "authored_system_credential_requests_continuation_status_check"
    CHECK ("continuation_status" IN ('pending', 'leased', 'succeeded', 'failed')),
  ADD CONSTRAINT "authored_system_credential_requests_continuation_attempts_check"
    CHECK ("continuation_attempts" >= 0);--> statement-breakpoint

CREATE INDEX "authored_system_credential_requests_continuation_idx"
  ON "authored_system_credential_requests" ("tenant_id", "continuation_status", "continuation_lease_until");--> statement-breakpoint

ALTER TABLE "chat_messages" ADD COLUMN "credential_request_id" uuid;--> statement-breakpoint
CREATE INDEX "chat_messages_credential_request_idx"
  ON "chat_messages" ("tenant_id", "credential_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_credential_request_agent_key"
  ON "chat_messages" ("credential_request_id")
  WHERE "role" = 'agent' AND "credential_request_id" IS NOT NULL;--> statement-breakpoint

-- A retried SDK delivery of one tool call is one approval. Different parallel
-- calls remain different even when their human descriptions happen to match.
CREATE UNIQUE INDEX "approvals_pending_tool_call_key"
  ON "approvals" ("run_id", (("payload"->'action'->>'toolCallId')))
  WHERE "status" = 'pending' AND ("payload"->'action'->>'toolCallId') IS NOT NULL;--> statement-breakpoint

-- Before this lifecycle existed, operators had to type “continue” themselves.
-- If the same conversation already contains a later agent run, preserve that
-- as the fulfilled handoff instead of waking old work a second time. A stored
-- request with no later answer remains pending and is recovered by the worker.
UPDATE "authored_system_credential_requests" request
SET "continuation_status" = 'succeeded',
    "continued_at" = COALESCE(request."resolved_at", now()),
    "continued_run_id" = (
      SELECT message."run_id"
      FROM "chat_messages" message
      WHERE message."thread_id" = request."thread_id"
        AND message."role" = 'agent'
        AND message."run_id" IS NOT NULL
        AND message."at" > COALESCE(request."resolved_at", request."created_at")
      ORDER BY message."at"
      LIMIT 1
    )
WHERE request."status" = 'stored'
  AND EXISTS (
    SELECT 1
    FROM "chat_messages" message
    WHERE message."thread_id" = request."thread_id"
      AND message."role" = 'agent'
      AND message."run_id" IS NOT NULL
      AND message."at" > COALESCE(request."resolved_at", request."created_at")
  );--> statement-breakpoint

-- Extend the existing projection state machine without weakening the sealed
-- request identity or any earlier transition law.
CREATE OR REPLACE FUNCTION enforce_authored_system_credential_request_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
    OR NEW.thread_id <> OLD.thread_id
    OR NEW.person_id <> OLD.person_id
    OR NEW.run_id <> OLD.run_id
    OR NEW.system_id <> OLD.system_id
    OR NEW.revision_version <> OLD.revision_version
    OR NEW.credential_label <> OLD.credential_label
    OR NEW.purpose <> OLD.purpose
    OR NEW.help_url IS DISTINCT FROM OLD.help_url
    OR NEW.expires_at <> OLD.expires_at
    OR NEW.created_at <> OLD.created_at
    OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'credential request identity and displayed scope are immutable';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('verifying', 'cancelled', 'expired')) OR
    (OLD.status = 'verifying' AND NEW.status IN ('pending', 'stored', 'expired'))
  ) THEN
    RAISE EXCEPTION 'invalid credential request transition: % -> %', OLD.status, NEW.status;
  END IF;

  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'credential request attempts may not decrease';
  END IF;
  IF NEW.continuation_attempts < OLD.continuation_attempts THEN
    RAISE EXCEPTION 'credential continuation attempts may not decrease';
  END IF;
  IF NEW.continuation_status <> OLD.continuation_status AND NOT (
    (OLD.continuation_status IN ('pending', 'failed') AND NEW.continuation_status = 'leased') OR
    (OLD.continuation_status = 'leased' AND NEW.continuation_status IN ('failed', 'succeeded'))
  ) THEN
    RAISE EXCEPTION 'invalid credential continuation transition: % -> %', OLD.continuation_status, NEW.continuation_status;
  END IF;
  IF NEW.continuation_status = 'leased' AND NEW.continuation_lease_until IS NULL THEN
    RAISE EXCEPTION 'leased credential continuations require a deadline';
  END IF;
  IF NEW.continued_at IS NOT NULL AND NEW.continuation_status NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'only terminal credential continuations may be stamped complete';
  END IF;
  IF NEW.continuation_status = 'succeeded'
    AND (NEW.continued_at IS NULL OR NEW.continued_run_id IS NULL) THEN
    RAISE EXCEPTION 'successful credential continuations require their run and completion time';
  END IF;
  IF NEW.continued_run_id IS DISTINCT FROM OLD.continued_run_id
    AND OLD.continued_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'a credential continuation run may not be replaced';
  END IF;
  IF NEW.status = 'verifying' AND NEW.verification_started_at IS NULL THEN
    RAISE EXCEPTION 'verifying credential requests require a start time';
  END IF;
  IF NEW.status IN ('stored', 'cancelled', 'expired') AND NEW.resolved_at IS NULL THEN
    RAISE EXCEPTION 'terminal credential requests require a resolution time';
  END IF;
  RETURN NEW;
END;
$$;
