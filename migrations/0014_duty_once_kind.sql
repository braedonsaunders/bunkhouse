-- Duties gain a one-shot kind: work scheduled for a single date and time
-- rather than a recurring pattern. Kept in its own migration file: the migrate
-- runner wraps each file in one transaction, and ALTER TYPE ... ADD VALUE must
-- not share a transaction with statements that use the new value.
ALTER TYPE "public"."duty_schedule_kind" ADD VALUE IF NOT EXISTS 'once';
