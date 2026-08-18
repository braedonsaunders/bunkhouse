CREATE UNIQUE INDEX "remote_computers_tenant_id_ux" ON "remote_computers" ("tenant_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "remote_sessions_tenant_id_ux" ON "remote_sessions" ("tenant_id", "id");--> statement-breakpoint

ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_tenant_computer_fk"
  FOREIGN KEY ("tenant_id", "computer_id") REFERENCES "public"."remote_computers"("tenant_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "remote_session_leases" ADD CONSTRAINT "remote_session_leases_tenant_session_fk"
  FOREIGN KEY ("tenant_id", "session_id") REFERENCES "public"."remote_sessions"("tenant_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "remote_session_events" ADD CONSTRAINT "remote_session_events_tenant_session_fk"
  FOREIGN KEY ("tenant_id", "session_id") REFERENCES "public"."remote_sessions"("tenant_id", "id") ON DELETE restrict;
