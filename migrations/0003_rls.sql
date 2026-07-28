ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_users;
DROP POLICY IF EXISTS tenant_write_insert ON tenant_users;
DROP POLICY IF EXISTS tenant_write_update ON tenant_users;
DROP POLICY IF EXISTS tenant_write_delete ON tenant_users;
CREATE POLICY tenant_isolation ON tenant_users
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON roles;
DROP POLICY IF EXISTS tenant_write_insert ON roles;
DROP POLICY IF EXISTS tenant_write_update ON roles;
DROP POLICY IF EXISTS tenant_write_delete ON roles;
CREATE POLICY tenant_isolation ON roles
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_assignments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON role_assignments;
DROP POLICY IF EXISTS tenant_write_insert ON role_assignments;
DROP POLICY IF EXISTS tenant_write_update ON role_assignments;
DROP POLICY IF EXISTS tenant_write_delete ON role_assignments;
CREATE POLICY tenant_isolation ON role_assignments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE user_permission_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_permission_overrides FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON user_permission_overrides;
DROP POLICY IF EXISTS tenant_write_insert ON user_permission_overrides;
DROP POLICY IF EXISTS tenant_write_update ON user_permission_overrides;
DROP POLICY IF EXISTS tenant_write_delete ON user_permission_overrides;
CREATE POLICY tenant_isolation ON user_permission_overrides
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_log;
DROP POLICY IF EXISTS tenant_write_insert ON audit_log;
DROP POLICY IF EXISTS tenant_write_update ON audit_log;
DROP POLICY IF EXISTS tenant_write_delete ON audit_log;
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE domain_event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_event_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON domain_event_outbox;
DROP POLICY IF EXISTS tenant_write_insert ON domain_event_outbox;
DROP POLICY IF EXISTS tenant_write_update ON domain_event_outbox;
DROP POLICY IF EXISTS tenant_write_delete ON domain_event_outbox;
CREATE POLICY tenant_isolation ON domain_event_outbox
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE domain_event_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_event_effects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON domain_event_effects;
DROP POLICY IF EXISTS tenant_write_insert ON domain_event_effects;
DROP POLICY IF EXISTS tenant_write_update ON domain_event_effects;
DROP POLICY IF EXISTS tenant_write_delete ON domain_event_effects;
CREATE POLICY tenant_isolation ON domain_event_effects
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON api_keys;
DROP POLICY IF EXISTS tenant_write_insert ON api_keys;
DROP POLICY IF EXISTS tenant_write_update ON api_keys;
DROP POLICY IF EXISTS tenant_write_delete ON api_keys;
CREATE POLICY tenant_isolation ON api_keys
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE api_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_idempotency_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON api_idempotency_keys;
DROP POLICY IF EXISTS tenant_write_insert ON api_idempotency_keys;
DROP POLICY IF EXISTS tenant_write_update ON api_idempotency_keys;
DROP POLICY IF EXISTS tenant_write_delete ON api_idempotency_keys;
CREATE POLICY tenant_isolation ON api_idempotency_keys
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE people ENABLE ROW LEVEL SECURITY;
ALTER TABLE people FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON people;
DROP POLICY IF EXISTS tenant_write_insert ON people;
DROP POLICY IF EXISTS tenant_write_update ON people;
DROP POLICY IF EXISTS tenant_write_delete ON people;
CREATE POLICY tenant_isolation ON people
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE mailbox_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailbox_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mailbox_accounts;
DROP POLICY IF EXISTS tenant_write_insert ON mailbox_accounts;
DROP POLICY IF EXISTS tenant_write_update ON mailbox_accounts;
DROP POLICY IF EXISTS tenant_write_delete ON mailbox_accounts;
CREATE POLICY tenant_isolation ON mailbox_accounts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE mail_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_threads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_threads;
DROP POLICY IF EXISTS tenant_write_insert ON mail_threads;
DROP POLICY IF EXISTS tenant_write_update ON mail_threads;
DROP POLICY IF EXISTS tenant_write_delete ON mail_threads;
CREATE POLICY tenant_isolation ON mail_threads
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE mail_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_messages;
DROP POLICY IF EXISTS tenant_write_insert ON mail_messages;
DROP POLICY IF EXISTS tenant_write_update ON mail_messages;
DROP POLICY IF EXISTS tenant_write_delete ON mail_messages;
CREATE POLICY tenant_isolation ON mail_messages
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE procedures ENABLE ROW LEVEL SECURITY;
ALTER TABLE procedures FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON procedures;
DROP POLICY IF EXISTS tenant_write_insert ON procedures;
DROP POLICY IF EXISTS tenant_write_update ON procedures;
DROP POLICY IF EXISTS tenant_write_delete ON procedures;
CREATE POLICY tenant_isolation ON procedures
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE procedure_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE procedure_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON procedure_revisions;
DROP POLICY IF EXISTS tenant_write_insert ON procedure_revisions;
DROP POLICY IF EXISTS tenant_write_update ON procedure_revisions;
DROP POLICY IF EXISTS tenant_write_delete ON procedure_revisions;
CREATE POLICY tenant_isolation ON procedure_revisions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON memories;
DROP POLICY IF EXISTS tenant_write_insert ON memories;
DROP POLICY IF EXISTS tenant_write_update ON memories;
DROP POLICY IF EXISTS tenant_write_delete ON memories;
CREATE POLICY tenant_isolation ON memories
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE duties ENABLE ROW LEVEL SECURITY;
ALTER TABLE duties FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON duties;
DROP POLICY IF EXISTS tenant_write_insert ON duties;
DROP POLICY IF EXISTS tenant_write_update ON duties;
DROP POLICY IF EXISTS tenant_write_delete ON duties;
CREATE POLICY tenant_isolation ON duties
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON runs;
DROP POLICY IF EXISTS tenant_write_insert ON runs;
DROP POLICY IF EXISTS tenant_write_update ON runs;
DROP POLICY IF EXISTS tenant_write_delete ON runs;
CREATE POLICY tenant_isolation ON runs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON run_events;
DROP POLICY IF EXISTS tenant_write_insert ON run_events;
DROP POLICY IF EXISTS tenant_write_update ON run_events;
DROP POLICY IF EXISTS tenant_write_delete ON run_events;
CREATE POLICY tenant_isolation ON run_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE token_spend ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_spend FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON token_spend;
DROP POLICY IF EXISTS tenant_write_insert ON token_spend;
DROP POLICY IF EXISTS tenant_write_update ON token_spend;
DROP POLICY IF EXISTS tenant_write_delete ON token_spend;
CREATE POLICY tenant_isolation ON token_spend
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE autonomy_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE autonomy_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON autonomy_settings;
DROP POLICY IF EXISTS tenant_write_insert ON autonomy_settings;
DROP POLICY IF EXISTS tenant_write_update ON autonomy_settings;
DROP POLICY IF EXISTS tenant_write_delete ON autonomy_settings;
CREATE POLICY tenant_isolation ON autonomy_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON approvals;
DROP POLICY IF EXISTS tenant_write_insert ON approvals;
DROP POLICY IF EXISTS tenant_write_update ON approvals;
DROP POLICY IF EXISTS tenant_write_delete ON approvals;
CREATE POLICY tenant_isolation ON approvals
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

