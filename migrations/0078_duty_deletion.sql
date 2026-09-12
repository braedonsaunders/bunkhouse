-- A duty can be deleted, not just cancelled.
--
-- Cancel was the deepest control an agent had: `enabled = 'off'`,
-- `next_due_at = null`, and the row stays in every listing forever. That was
-- right for a lane you might resume, and wrong for the pile of dead renewals
-- a self-renewing watch lane leaves behind it (`-b-8` → `-b-9` → …): the list
-- grows by one row per renewal, none of them can ever run again, and the
-- agent has no way to clean up after itself. One agent on the live tenant
-- carries twenty-two of them.
--
-- The row is not hard-deleted. Three things name a duty by id after it is
-- gone: the run history it produced (the conversation's work surface joins
-- runs back to duties by `trigger->>'dutyId'`), the renewal chains
-- (`duty-conversation.ts` walks duty → source run → older duty to find where
-- a scheduled lane may speak — hard-deleting a link makes every duty behind
-- it resolve to no conversation and be born mute), and the audit log. So
-- deletion is a lifecycle state, not an erasure: `deleted_at` set,
-- `enabled = 'off'`, `next_due_at = null`, gone from every listing and every
-- scheduling decision, present for every join that resolves history.
ALTER TABLE "duties"
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;--> statement-breakpoint

COMMENT ON COLUMN "duties"."deleted_at" IS
  'Set when the duty is deleted: gone from listings and scheduling, never to fire again, kept so run history and renewal chains that name it stay resolvable.';
