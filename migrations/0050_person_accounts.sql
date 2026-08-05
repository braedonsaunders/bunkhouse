-- A workspace login and its human directory record are one business identity.
-- The global user may join several tenants, so the link is unique inside the
-- tenant rather than globally. Existing rows all carry a null user_id; the
-- boot reconciliation adopts or provisions them after this constraint lands.

CREATE UNIQUE INDEX people_tenant_user_key
  ON people (tenant_id, user_id)
  WHERE user_id IS NOT NULL;

ALTER TABLE people
  ADD CONSTRAINT people_user_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE people
  ADD CONSTRAINT people_agent_user_check
  CHECK (kind = 'human' OR user_id IS NULL);
