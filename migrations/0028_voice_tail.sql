-- The voice tail: recordings, retention, voicemail, call-minute budgets and
-- speech pricing.
--
-- Only one column is new. Everything else this slice needs is tenant
-- configuration, and configuration lives where all of it lives — one
-- tenant_settings row per key ('voice.retention', 'voice.pricing') — and one
-- optional field inside the agent's existing salary jsonb
-- (salary.monthlyCallMinutes), which older rows simply do not carry. No new
-- tables, so no new RLS policies: call_sessions is already isolated by
-- 0011_voice, and tenant_settings by 0004_settings.
--
-- call_sessions.recording_file_id points at the files ledger row for the
-- call's audio, written straight to the tenant's object storage by LiveKit
-- Egress. It is nullable because a recording is genuinely optional: egress may
-- be unavailable on the deployment, it may fail, and the retention sweep
-- clears the column and the file row together when a recording ages out.

ALTER TABLE "call_sessions" ADD COLUMN "recording_file_id" uuid;--> statement-breakpoint
-- The retention sweep walks recordings by age, so only rows that still hold
-- one belong in the index.
CREATE INDEX "call_sessions_recording_idx"
  ON "call_sessions" USING btree ("tenant_id","started_at")
  WHERE "recording_file_id" is not null;
