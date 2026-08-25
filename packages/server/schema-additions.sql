-- Current-release additions contain only explicitly reviewed, bounded schema
-- changes or one-time data changes for the active release cycle.
-- After every controlled database has applied an entry, the following release
-- moves it into schema.sql and removes it here. Keep this asset as a comment-only
-- placeholder when no delta is pending; do not skip a release carrying entries.
-- The schema bootstrap owns the transaction that covers this file and the
-- following readiness check. Do not add transaction control statements here.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'metadata'
       AND column_name = 'created_by'
  ) THEN
    ALTER TABLE metadata ADD COLUMN created_by TEXT;
  END IF;
END
$$;

UPDATE metadata
   SET created_by = 'wozsun'
 WHERE created_by IS NULL;

DO $$
DECLARE
  created_by_nullable TEXT;
  created_by_default TEXT;
BEGIN
  SELECT is_nullable, column_default
    INTO created_by_nullable, created_by_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'metadata'
     AND column_name = 'created_by';

  IF created_by_nullable = 'YES' THEN
    ALTER TABLE metadata ALTER COLUMN created_by SET NOT NULL;
  END IF;
  IF created_by_default IS NOT NULL THEN
    ALTER TABLE metadata ALTER COLUMN created_by DROP DEFAULT;
  END IF;
END
$$;
