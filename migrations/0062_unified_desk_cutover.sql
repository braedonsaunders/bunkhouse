-- Bunkhouse has not launched with production tenant data. Complete the Desk
-- cutover cleanly: browser, shell, desktop input, files, and screen frames now
-- share desk_sessions/desk_events, so the retired ledgers must not remain as a
-- second source of truth or tempt new compatibility writes.
DROP TABLE IF EXISTS browser_steps CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS browser_sessions CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS shell_sessions CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS browser_session_status;--> statement-breakpoint
DROP TYPE IF EXISTS shell_session_status;
