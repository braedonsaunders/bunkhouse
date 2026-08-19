-- A governed chat turn can pause for approval, but the resumed outcome is
-- still part of that conversation. The approval id is its durable delivery
-- key: retries may recover the work, never repeat the agent's reply.
ALTER TABLE "chat_messages" ADD COLUMN "approval_id" uuid;--> statement-breakpoint
CREATE INDEX "chat_messages_approval_idx" ON "chat_messages" ("tenant_id", "approval_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_approval_agent_key"
  ON "chat_messages" ("approval_id")
  WHERE "role" = 'agent' AND "approval_id" IS NOT NULL;
