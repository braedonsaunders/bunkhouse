-- A run budget is the agent's to set, or nobody's.
--
-- 0076 added `duties.standing` so the pass that stamped `max_runs = 12` onto
-- uncapped duties could tell a routine somebody asked for from one an agent
-- invented. That pass is gone, so the column has no reader.
--
-- Removing the pass rather than teaching it to aim better is the actual fix.
-- Retrofitting a bound onto work already running cannot be made safe whatever
-- the predicate: the duty is mid-flight, nobody asked for a bound, and the
-- failure is silent and total — a null next run and an inactive row, which reads
-- as the platform having lost the task. And the cap was unreachable as designed
-- anyway: a duty-triggered run was never in a "person is asking" context, so a
-- lane could only ever renew itself as another bounded twelve. Agents built
-- renewal chains to keep continuous work alive, which is precisely what the cap
-- was added to prevent, and left a dead `-2`, `-3`, `-4` duty behind each time.
--
-- What 0076 repaired stands: the caps it wrongly wrote are still cleared, and the
-- audit log still records, per duty, whether a person asked for it.
ALTER TABLE "duties" DROP COLUMN IF EXISTS "standing";--> statement-breakpoint

-- And clear the default off the lanes still running.
--
-- Every duty an agent booked before now carries 12 whether it chose that number
-- or merely failed to pass one — `scheduledRunLimit` returned the ceiling for
-- both, so the row cannot tell them apart and neither can anyone reading it. A
-- live lane must not die on a bound nobody chose, so enabled duties lose it.
--
-- Scoped to what an agent booked for itself and is still running. Retired duties
-- keep their numbers as history; a duty whose cap an operator set in the People
-- UI has `created_by <> person_id` and is untouched; role-pack duties belong to
-- the role.
UPDATE "duties"
   SET "max_runs" = NULL,
       "updated_at" = now()
 WHERE "enabled" = 'on'
   AND "max_runs" = 12
   AND "schedule_kind" = 'cron'
   AND "created_by" = "person_id"
   AND "from_role_pack_duty" IS NULL;
