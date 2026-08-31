-- Current-release additions contain only explicitly reviewed, bounded schema
-- changes or one-time data changes for the active release cycle.
-- After every controlled database has applied an entry, the following release
-- moves it into schema.sql and restores this comment-only placeholder. Do not
-- skip a release carrying entries.
-- The schema bootstrap owns the transaction that covers this file and the
-- following readiness check. Do not add transaction control statements here.

-- 5.4.2 moves persistent trash-purge ownership to background_job. Existing
-- rows naturally remain recoverable because the new owner is nullable. The
-- one-cycle TypeScript bootstrap compatibility step atomically preserves any
-- unfinished legacy deletion intent and then removes the four old columns,
-- their CHECK and their partial index before readiness runs.
DO $$
BEGIN
  -- PostgreSQL checks table ownership even for ADD ... IF NOT EXISTS. Probe the
  -- catalog first so an already provisioned current schema can be verified by
  -- a narrower runtime role without attempting no-op DDL.
  IF to_regclass('public.metadata') IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid='public.metadata'::regclass
       AND attname='purge_job_id'
       AND attnum > 0
       AND NOT attisdropped
  ) THEN
    ALTER TABLE metadata ADD COLUMN purge_job_id UUID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid='public.metadata'::regclass
       AND conname='metadata_purge_job_deleted_check'
  ) THEN
    ALTER TABLE metadata
      ADD CONSTRAINT metadata_purge_job_deleted_check
      CHECK (purge_job_id IS NULL OR status='deleted') NOT VALID;
    ALTER TABLE metadata
      VALIDATE CONSTRAINT metadata_purge_job_deleted_check;
  END IF;
END
$$;
