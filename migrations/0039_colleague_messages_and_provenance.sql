-- Two things a screenful of runaway work turned out to need.
--
-- FIRST: an inbox. Two agents at one company have to be able to say something
-- to each other without it becoming a job and without it becoming a memory.
-- Both were tried:
--
--   * as an assignment, every message was a full model run — so an
--     acknowledgement cost what an hour of research costs. Four test phone
--     calls (four runs, twenty cents) produced 913 assignments and fifty-three
--     dollars, and the titles say exactly what they were:
--     "Re: Re: Re: Re: Daily check-in outcome — posture confirmed".
--     Agents thanking each other for thanking each other, each thank-you a
--     unit of work.
--   * as a note in the recipient's logbook it stopped costing runs, but the
--     logbook is where an agent keeps what it has LEARNED. Messages there
--     compete for the retrieval budget, age through the gardener, and get
--     weighed for importance beside real facts. A message is not a lesson.
--
-- So it is its own store, with the one property that matters: it waits. The
-- recipient reads it next time they are working, whatever started them.
--
-- SECOND: provenance. Nothing recorded which human ask a piece of work
-- descended from, so there was no way to say what one request had cost and no
-- way to stop it — the only thing that noticed nine hundred assignments was
-- the invoice. A call, an inbound email, an operator pressing go: those are
-- roots. Everything derived from one carries the same root however far it
-- spreads, so the cost of one request can be totalled and bounded.

CREATE TABLE IF NOT EXISTS "colleague_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "from_person_id" uuid NOT NULL,
  "to_person_id" uuid NOT NULL,
  "subject" text NOT NULL,
  "body" text NOT NULL,
  "run_id" uuid,
  "root_run_id" uuid,
  "read_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The inbox query: everything unread for one person, oldest first.
CREATE INDEX IF NOT EXISTS "colleague_messages_inbox_idx"
  ON "colleague_messages" ("tenant_id", "to_person_id", "read_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "colleague_messages_root_idx"
  ON "colleague_messages" ("tenant_id", "root_run_id");
--> statement-breakpoint
-- Every tenant-scoped table is read under RLS by the app role; the pattern
-- matches every other table in this schema.
ALTER TABLE "colleague_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON colleague_messages;
--> statement-breakpoint
-- nullif, because an unset app.tenant_id is the empty string and casting that
-- to uuid raises rather than matching nothing — the same shape every other
-- policy in this schema uses.
CREATE POLICY tenant_isolation ON colleague_messages
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "root_run_id" uuid;
--> statement-breakpoint
-- Totalling what one ask has cost means summing spend across every run sharing
-- a root, so that lookup is indexed rather than a scan of the run table.
CREATE INDEX IF NOT EXISTS "runs_root_idx" ON "runs" ("tenant_id", "root_run_id");
