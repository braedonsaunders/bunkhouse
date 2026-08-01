CREATE TYPE approval_execution_status AS ENUM ('pending', 'leased', 'succeeded', 'failed');

ALTER TABLE approvals
  ADD COLUMN execution_status approval_execution_status NOT NULL DEFAULT 'pending',
  ADD COLUMN execution_lease_until timestamptz,
  ADD COLUMN execution_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN execution_error text;

UPDATE approvals
SET execution_status = 'succeeded'
WHERE executed_at IS NOT NULL;

CREATE INDEX approvals_execution_idx
  ON approvals (tenant_id, execution_status, execution_lease_until);
