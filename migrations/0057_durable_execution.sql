-- A mutable run row is the authority for who may execute. Attempts, effects,
-- and their outcomes are immutable evidence: retries append facts and never
-- rewrite history.
ALTER TABLE runs ADD COLUMN lease_fence integer NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN lease_owner text;
ALTER TABLE runs ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE runs ADD COLUMN active_attempt_id uuid;
CREATE UNIQUE INDEX runs_tenant_id_id_key ON runs (tenant_id, id);

CREATE TABLE run_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  owner text NOT NULL,
  fence integer NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX run_attempts_run_fence_key ON run_attempts (run_id, fence);
CREATE UNIQUE INDEX run_attempts_tenant_id_id_key ON run_attempts (tenant_id, id);
CREATE INDEX run_attempts_run_idx ON run_attempts (tenant_id, run_id, started_at);
ALTER TABLE run_attempts ADD CONSTRAINT run_attempts_tenant_run_fk
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs (tenant_id, id);

CREATE TABLE run_attempt_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  tenant_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  seq integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('claimed','renewed','completed','failed','cancelled','lease_lost')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX run_attempt_events_seq_key ON run_attempt_events (attempt_id, seq);
CREATE INDEX run_attempt_events_attempt_idx ON run_attempt_events (tenant_id, attempt_id);
ALTER TABLE run_attempt_events ADD CONSTRAINT run_attempt_events_tenant_attempt_fk
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES run_attempts (tenant_id, id);
ALTER TABLE runs ADD CONSTRAINT runs_tenant_active_attempt_fk
  FOREIGN KEY (tenant_id, active_attempt_id) REFERENCES run_attempts (tenant_id, id);

CREATE TABLE external_effect_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  provenance_kind text NOT NULL CHECK (provenance_kind IN ('run_attempt','approval')),
  attempt_id uuid NOT NULL,
  kind text NOT NULL,
  idempotency_key text NOT NULL,
  request jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX external_effect_intents_key ON external_effect_intents (tenant_id, idempotency_key);
CREATE UNIQUE INDEX external_effect_intents_tenant_id_id_key ON external_effect_intents (tenant_id, id);
CREATE INDEX external_effect_intents_run_idx ON external_effect_intents (tenant_id, run_id, created_at);
ALTER TABLE external_effect_intents ADD CONSTRAINT external_effect_intents_tenant_run_fk
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs (tenant_id, id);

-- The AppKit protocol calls the authority `attemptId`; Bunkhouse has two
-- legitimate fenced executors: model run attempts and approval executions.
-- Enforce that polymorphic provenance at the database boundary rather than
-- trusting an application-supplied UUID.
CREATE OR REPLACE FUNCTION enforce_external_effect_provenance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provenance_kind = 'run_attempt' THEN
    IF NOT EXISTS (
      SELECT 1 FROM run_attempts
      WHERE id = NEW.attempt_id AND tenant_id = NEW.tenant_id AND run_id = NEW.run_id
    ) THEN
      RAISE foreign_key_violation USING MESSAGE = 'external effect run-attempt provenance is invalid';
    END IF;
  ELSIF NEW.provenance_kind = 'approval' THEN
    IF NOT EXISTS (
      SELECT 1 FROM approvals
      WHERE id = NEW.attempt_id AND tenant_id = NEW.tenant_id AND run_id = NEW.run_id
    ) THEN
      RAISE foreign_key_violation USING MESSAGE = 'external effect approval provenance is invalid';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER external_effect_intents_provenance
  BEFORE INSERT ON external_effect_intents
  FOR EACH ROW EXECUTE FUNCTION enforce_external_effect_provenance();

CREATE TABLE external_effect_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  tenant_id uuid NOT NULL,
  effect_id uuid NOT NULL,
  seq integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('retry_started','completed','failed','ambiguous','reconciled')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX external_effect_events_seq_key ON external_effect_events (effect_id, seq);
CREATE INDEX external_effect_events_effect_idx ON external_effect_events (tenant_id, effect_id);
ALTER TABLE external_effect_events ADD CONSTRAINT external_effect_events_tenant_effect_fk
  FOREIGN KEY (tenant_id, effect_id) REFERENCES external_effect_intents (tenant_id, id);

DO $$
DECLARE ledger text;
BEGIN
  FOREACH ledger IN ARRAY ARRAY[
    'run_attempts',
    'run_attempt_events',
    'external_effect_intents',
    'external_effect_events'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', ledger || '_immutable', ledger);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_ledger_change()',
      ledger || '_immutable', ledger
    );
  END LOOP;
END;
$$;

DO $$
DECLARE tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'run_attempts',
    'run_attempt_events',
    'external_effect_intents',
    'external_effect_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tenant_table);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      tenant_table
    );
  END LOOP;
END;
$$;
