CREATE TABLE "meeting_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"token" text NOT NULL,
	"created_by_person_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"joined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "meeting_links" ADD CONSTRAINT "meeting_links_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."call_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_links_token_key" ON "meeting_links" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_links_session_key" ON "meeting_links" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "meeting_links_person_idx" ON "meeting_links" USING btree ("tenant_id","created_by_person_id","created_at");

ALTER TABLE meeting_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON meeting_links;
CREATE POLICY tenant_isolation ON meeting_links
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
