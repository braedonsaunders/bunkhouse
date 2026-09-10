-- A routine a person actually asked for, said out loud on the row.
--
-- "Standing" was never recorded anywhere a query could see it. It existed only
-- as `max_runs IS NULL`, and the agent is `created_by` whether it booked the
-- repeat on its own judgment or a person asked for it in the conversation — so
-- a duty somebody requested and a duty an agent invented are the same row.
--
-- `staleBeliefsPass` relies on exactly that pair to cap runaway self-booking:
--
--     update duties set max_runs = 12
--      where max_runs is null and schedule_kind = 'cron' and created_by = person_id
--
-- which means it has been capping the routines people explicitly asked for, too.
-- On the live tenant all fifteen of one agent's standing duties now carry
-- `max_runs = 12`, every one of them created with no cap at all. Two are
-- arithmetically impossible and prove the order of events: a one-minute watch
-- lane shows 176 runs against a cap of 12, and a five-minute position monitor
-- shows 36. They ran as asked, the pass stamped a cap on afterwards, the next
-- occurrence computed as spent, and the duty retired itself with
-- `next_due_at = null`. Every "24/7" lane in that account died this way, and
-- nothing said so — the agent read the wreckage and blamed host restarts.
--
-- So the distinction becomes data. `false` is the correct default for every
-- existing row: a bounded duty is not standing, and the backfill below promotes
-- only those the audit log can prove were requested.
ALTER TABLE "duties"
  ADD COLUMN IF NOT EXISTS "standing" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- The audit log is the only surviving record of intent.
--
-- `schedule_task` has always written `metadata.standing` at creation, so the
-- question "did a person ask for this one?" is answerable for every duty an
-- agent ever booked. This reads that answer back onto the duty.
UPDATE "duties" d
   SET "standing" = true,
       "updated_at" = now()
  FROM "audit_log" a
 WHERE a."entity_type" = 'duty'
   AND a."action" = 'created_by_employee'
   AND a."entity_id" = d."id"::text
   AND a."metadata"->>'standing' = 'true'
   AND d."standing" = false;--> statement-breakpoint

-- And undo the capping where it was wrong.
--
-- A standing duty has no run budget by definition, so the cap the pass wrote is
-- not a number to be corrected — it should not be there. Scoped to rows the
-- audit log just proved were requested, and only where the cap equals the one
-- that pass writes: a duty whose cap somebody set deliberately in the UI is a
-- different thing and is left exactly as it is.
UPDATE "duties"
   SET "max_runs" = NULL,
       "updated_at" = now()
 WHERE "standing" = true
   AND "max_runs" = 12
   AND "schedule_kind" = 'cron'
   AND "created_by" = "person_id"
   AND "from_role_pack_duty" IS NULL;--> statement-breakpoint

-- Retired duties are NOT re-armed here.
--
-- Clearing the cap makes them eligible to run again, but a migration is the
-- wrong place to decide that a one-minute trading lane should resume: some of
-- these were also cancelled deliberately, restarting them spends money, and the
-- operator is the only one who knows which lanes are still wanted. They stay
-- `enabled = 'off'` with the cap removed, so turning one back on is a decision
-- rather than a side effect of deploying.
COMMENT ON COLUMN "duties"."standing" IS
  'A person explicitly asked for this routine, so it has no run budget and the self-booking cap must not touch it.';
