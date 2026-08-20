-- Who a standing deliverable goes to, said out loud.
--
-- Until now a duty's recipients lived only in its instruction prose — "Email
-- the report to the Owner" — and the agent inferred who that meant. It infers
-- correctly right up until the answer changes, and then it is confidently
-- wrong with no signal anywhere: the run completes, the email sends, and it
-- goes to whoever the model still believes the Owner is.
--
-- `deliver_to` makes the answer data instead of an inference. An empty array
-- is the honest default for every existing duty: it means "nothing declared
-- here", so the instruction keeps working exactly as it does today and nothing
-- silently changes recipients on the next run.
ALTER TABLE "duties"
  ADD COLUMN IF NOT EXISTS "deliver_to" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

-- The constraint checks that this is a list, and stops there.
--
-- Validating each entry's shape needs a subquery over jsonb_array_elements,
-- and Postgres does not permit subqueries in CHECK — so the choice is a
-- constraint that cannot see inside the array, or an immutable helper function
-- that can. The helper is not worth it: which channels exist and what fields
-- each one needs is application policy that will change, and pinning it in the
-- schema means a migration every time a channel is added. Entries are parsed
-- and refused loudly on the way in (readDeliveryTargets), which is where a bad
-- recipient can actually be reported to the person who typed it.
ALTER TABLE "duties"
  DROP CONSTRAINT IF EXISTS "duties_deliver_to_shape_check";--> statement-breakpoint

ALTER TABLE "duties"
  ADD CONSTRAINT "duties_deliver_to_is_array_check"
    CHECK (jsonb_typeof("deliver_to") = 'array');--> statement-breakpoint
