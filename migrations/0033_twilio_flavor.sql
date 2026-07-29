-- The carrier trunk flavor: a Twilio Elastic SIP Trunk this deployment
-- provisions itself. Kept in its own migration file: the migrate runner wraps
-- each file in one transaction, and ALTER TYPE ... ADD VALUE must not share a
-- transaction with statements that use the new value.
ALTER TYPE "public"."sip_trunk_flavor" ADD VALUE IF NOT EXISTS 'twilio_sip';
