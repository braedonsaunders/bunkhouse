-- The in-app chat surface: a person holding a conversation with one agent
-- while watching its desk. Doctrine #1 — mail is the primary surface and chat
-- is secondary — so these two tables are deliberately NOT a second work
-- system. They are a VIEW ONTO RUNS.
--
-- What that means concretely, and why it is worth two tables at all:
--
--   · Every message a person sends here becomes exactly the same governed run
--     `executeAgentRun` already produces for an inbound email or a Slack
--     message: trigger `{ type: 'chat', conversationId }`, input
--     `{ type: 'chat', message }`. Same dial, same approvals, same budget
--     meter, same runs/run_events ledger. Nothing about a web chat message
--     reaches a different loop, and no work exists here that does not exist as
--     a run. `chat_messages.run_id` is the join back to it.
--   · What these tables add is the thing a run genuinely does not have: the
--     ordered, human-readable conversation a person can come back to. Slack
--     and Teams keep that in Slack and Teams (chat_channel_routes /
--     chat_inbound_events are only the bridge's own plumbing); the in-app
--     surface has nowhere else to keep it, so it keeps it here.
--
-- chat_messages is APPEND-ONLY at the database boundary, like every other
-- ledger in this system (0047). A correction is a new message — never an edit
-- of what was already said. `seq` is unique per thread and allocated under a
-- per-thread advisory lock, so two turns posted at once can never collide or
-- reorder.
--
-- chat_threads itself is mutable: a title is derived once from the opening
-- message, `last_message_at` moves as the conversation does, and status opens
-- and closes. None of those reinterpret history.
CREATE TYPE "public"."chat_thread_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."chat_message_role" AS ENUM('user', 'agent', 'system');--> statement-breakpoint
CREATE TABLE "chat_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text,
	"status" "chat_thread_status" DEFAULT 'open' NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" "chat_message_role" NOT NULL,
	"body" text NOT NULL,
	"run_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The thread list is "my conversations, most recent first"; the agent profile
-- asks the other question, "who has been talking to this employee".
CREATE INDEX "chat_threads_user_idx" ON "chat_threads" USING btree ("tenant_id","user_id","last_message_at");--> statement-breakpoint
CREATE INDEX "chat_threads_person_idx" ON "chat_threads" USING btree ("tenant_id","person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_seq_key" ON "chat_messages" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE INDEX "chat_messages_thread_idx" ON "chat_messages" USING btree ("tenant_id","thread_id");--> statement-breakpoint
-- The run a message produced (or came from), for the join back to the ledger
-- that actually did the work.
CREATE INDEX "chat_messages_run_idx" ON "chat_messages" USING btree ("tenant_id","run_id");--> statement-breakpoint
-- Append-only: what was said is evidence. A correction is a new message.
DROP TRIGGER IF EXISTS chat_messages_immutable ON chat_messages;--> statement-breakpoint
CREATE TRIGGER chat_messages_immutable
BEFORE UPDATE OR DELETE ON chat_messages
FOR EACH ROW EXECUTE FUNCTION reject_immutable_ledger_change();

ALTER TABLE chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_threads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON chat_threads;
CREATE POLICY tenant_isolation ON chat_threads
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON chat_messages;
CREATE POLICY tenant_isolation ON chat_messages
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
