CREATE OR REPLACE FUNCTION reject_immutable_remote_history_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = TG_TABLE_NAME || ' is append-only';
END;
$$ LANGUAGE plpgsql;
