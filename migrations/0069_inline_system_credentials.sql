-- An employee may ask for a credential inside a conversation, but the value
-- itself must never become chat text, model context, or ledger detail. This
-- projection pins the visible request to the exact immutable system revision;
-- its companion ledger records every lifecycle transition without secrets.
CREATE TYPE "public"."authored_system_credential_request_status" AS ENUM(
  'pending', 'verifying', 'stored', 'cancelled', 'expired'
);--> statement-breakpoint
CREATE TYPE "public"."authored_system_credential_request_event_kind" AS ENUM(
  'requested', 'verification_started', 'verification_failed', 'stored', 'cancelled', 'expired'
);--> statement-breakpoint

CREATE TABLE "authored_system_credential_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "thread_id" uuid NOT NULL,
  "person_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "system_id" uuid NOT NULL,
  "revision_version" integer NOT NULL,
  "credential_label" text NOT NULL,
  "purpose" text NOT NULL,
  "help_url" text,
  "status" "authored_system_credential_request_status" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "verification_started_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "resolved_at" timestamp with time zone,
  "resolved_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid,
  CONSTRAINT "authored_system_credential_requests_revision_check" CHECK ("revision_version" > 0),
  CONSTRAINT "authored_system_credential_requests_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "authored_system_credential_requests_label_check" CHECK (
    length(btrim("credential_label")) BETWEEN 1 AND 120
  ),
  CONSTRAINT "authored_system_credential_requests_purpose_check" CHECK (
    length(btrim("purpose")) BETWEEN 1 AND 500
  ),
  CONSTRAINT "authored_system_credential_requests_help_url_check" CHECK (
    "help_url" IS NULL OR "help_url" ~ '^https://'
  )
);--> statement-breakpoint

CREATE TABLE "authored_system_credential_request_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "request_id" uuid NOT NULL,
  "seq" integer NOT NULL,
  "kind" "authored_system_credential_request_event_kind" NOT NULL,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "actor_type" text NOT NULL,
  "actor_id" uuid,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "authored_system_credential_request_events_seq_check" CHECK ("seq" > 0),
  CONSTRAINT "authored_system_credential_request_events_actor_check" CHECK (
    "actor_type" IN ('agent', 'user', 'system')
  )
);--> statement-breakpoint

CREATE UNIQUE INDEX "authored_system_credential_requests_tenant_id_ux"
  ON "authored_system_credential_requests" ("tenant_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "authored_system_credential_requests_pending_ux"
  ON "authored_system_credential_requests" ("tenant_id", "thread_id", "system_id")
  WHERE "status" IN ('pending', 'verifying');--> statement-breakpoint
CREATE INDEX "authored_system_credential_requests_thread_idx"
  ON "authored_system_credential_requests" ("tenant_id", "thread_id", "created_at");--> statement-breakpoint
CREATE INDEX "authored_system_credential_requests_system_idx"
  ON "authored_system_credential_requests" ("tenant_id", "system_id", "status");--> statement-breakpoint
CREATE UNIQUE INDEX "authored_system_credential_request_events_seq_ux"
  ON "authored_system_credential_request_events" ("request_id", "seq");--> statement-breakpoint
CREATE INDEX "authored_system_credential_request_events_tenant_idx"
  ON "authored_system_credential_request_events" ("tenant_id", "request_id", "seq");--> statement-breakpoint

ALTER TABLE "authored_system_credential_requests" ADD CONSTRAINT "authored_system_credential_requests_tenant_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "authored_system_credential_requests" ADD CONSTRAINT "authored_system_credential_requests_tenant_system_fk"
  FOREIGN KEY ("tenant_id", "system_id") REFERENCES "authored_systems"("tenant_id", "id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "authored_system_credential_request_events" ADD CONSTRAINT "authored_system_credential_request_events_tenant_request_fk"
  FOREIGN KEY ("tenant_id", "request_id")
  REFERENCES "authored_system_credential_requests"("tenant_id", "id") ON DELETE CASCADE;--> statement-breakpoint

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
  IF NEW.status = 'verifying' AND NEW.verification_started_at IS NULL THEN
    RAISE EXCEPTION 'verifying credential requests require a start time';
  END IF;
  IF NEW.status IN ('stored', 'cancelled', 'expired') AND NEW.resolved_at IS NULL THEN
    RAISE EXCEPTION 'terminal credential requests require a resolution time';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER authored_system_credential_requests_state_machine
BEFORE UPDATE ON authored_system_credential_requests
FOR EACH ROW EXECUTE FUNCTION enforce_authored_system_credential_request_change();--> statement-breakpoint

CREATE TRIGGER authored_system_credential_request_events_immutable
BEFORE UPDATE OR DELETE ON authored_system_credential_request_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_ledger_change();--> statement-breakpoint

ALTER TABLE "authored_system_credential_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "authored_system_credential_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "authored_system_credential_requests"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "authored_system_credential_request_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "authored_system_credential_request_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "authored_system_credential_request_events"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
