-- Ledger rows are evidence. Corrections are new rows; UPDATE and DELETE are
-- rejected at the database boundary even for code paths that bypass the UI.
CREATE OR REPLACE FUNCTION reject_immutable_ledger_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; write a correction record instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

DO $$
DECLARE
  ledger text;
BEGIN
  FOREACH ledger IN ARRAY ARRAY[
    'audit_log',
    'run_events',
    'token_spend',
    'mail_messages',
    'procedure_revisions',
    'memory_revisions',
    'model_prices',
    'cost_reconciliations',
    'browser_steps',
    'call_turns',
    'file_filings'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', ledger || '_immutable', ledger);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_ledger_change()',
      ledger || '_immutable',
      ledger
    );
  END LOOP;
END;
$$;
