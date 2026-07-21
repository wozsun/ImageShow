-- Freeze every table involved in the removal guard before observing it. This
-- closes the rolling-upgrade window in which an older process could insert a
-- proxy image or link cleanup after the guard but before the schema change.
LOCK TABLE metadata, import_session, background_job IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM metadata WHERE is_link) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'v3.11.0 migration blocked: proxy images still exist',
      HINT = 'Remove or re-import every metadata row with is_link=true before retrying the migration.';
  END IF;

  IF EXISTS (SELECT 1 FROM import_session WHERE mode = 'proxy') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'v3.11.0 migration blocked: proxy import sessions still exist',
      HINT = 'Resolve every import_session row with mode=proxy before retrying the migration.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM background_job
    WHERE type = 'move.cleanup'
      AND status IN ('pending', 'running', 'failed')
      AND payload @? '$.objects[*] ? (@.prefix == "link")'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'v3.11.0 migration blocked: unresolved proxy-image cleanup exists',
      HINT = 'Resolve move.cleanup jobs that reference the link prefix before retrying the migration.';
  END IF;
END
$$;

-- The old receiving state covered both an incomplete .raw.part and an
-- atomically published .raw file. Keep it recoverable without claiming that
-- the material is complete: the v3.11 materializer promotes a complete .raw
-- to received, while an incomplete attempt can be transferred again.
ALTER TABLE import_session
  DROP CONSTRAINT import_session_mode_check,
  DROP CONSTRAINT import_session_status_check;

UPDATE import_session
SET status = 'materializing', updated_at = now()
WHERE status = 'receiving';

ALTER TABLE import_session
  ADD CONSTRAINT import_session_mode_check
    CHECK (mode IN ('upload', 'download')),
  ADD CONSTRAINT import_session_status_check
    CHECK (status IN (
      'created', 'materializing', 'received', 'preparing', 'ready',
      'committing', 'finalized', 'failed', 'cancelled'
    ));

ALTER TABLE metadata DROP COLUMN is_link;
