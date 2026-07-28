-- Outbound calls carry a briefing: the agent placed the call for a reason, and
-- the voice worker reads it back to open the conversation. Null on inbound and
-- web sessions, where the caller states their own business.
ALTER TABLE "call_sessions" ADD COLUMN "purpose" text;
