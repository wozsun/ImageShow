-- Current-release additions contain only explicitly reviewed, bounded schema
-- changes or one-time data changes for the active release cycle.
-- After every controlled database has applied an entry, the following release
-- moves it into schema.sql and restores this comment-only placeholder. Do not
-- skip a release carrying entries.
-- The schema bootstrap owns the transaction that covers this file and the
-- following readiness check. Do not add transaction control statements here.

-- 5.4.0 adds provider-neutral author identity columns. Existing rows naturally
-- satisfy the nullable invariant; the legacy RuntimeConfig mapping is migrated
-- only after this transaction and readiness have succeeded.
DO $$
BEGIN
  -- PostgreSQL checks table ownership even for ADD ... IF NOT EXISTS. Probe the
  -- catalog first so an already provisioned current schema can be verified by
  -- a narrower runtime role without attempting no-op DDL.
  IF to_regclass('public.author') IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid='public.author'::regclass
       AND attname='identity_provider'
       AND attnum > 0
       AND NOT attisdropped
  ) THEN
    ALTER TABLE author ADD COLUMN identity_provider TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid='public.author'::regclass
       AND attname='identity_id'
       AND attnum > 0
       AND NOT attisdropped
  ) THEN
    ALTER TABLE author ADD COLUMN identity_id TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid='public.author'::regclass
       AND conname='author_identity_pair_check'
  ) THEN
    ALTER TABLE author
      ADD CONSTRAINT author_identity_pair_check
      CHECK (
        (identity_provider IS NULL AND identity_id IS NULL)
        OR (identity_provider IS NOT NULL AND identity_id IS NOT NULL)
      ) NOT VALID;
    ALTER TABLE author VALIDATE CONSTRAINT author_identity_pair_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid='public.author'::regclass
       AND conname='author_identity_provider_token_check'
  ) THEN
    ALTER TABLE author
      ADD CONSTRAINT author_identity_provider_token_check
      CHECK (
        identity_provider IS NULL
        OR (
          char_length(identity_provider) BETWEEN 1 AND 32
          AND identity_provider ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
        )
      ) NOT VALID;
    ALTER TABLE author
      VALIDATE CONSTRAINT author_identity_provider_token_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid='public.author'::regclass
       AND conname='author_identity_id_nonempty_check'
  ) THEN
    ALTER TABLE author
      ADD CONSTRAINT author_identity_id_nonempty_check
      CHECK (identity_id IS NULL OR char_length(identity_id) > 0) NOT VALID;
    ALTER TABLE author
      VALIDATE CONSTRAINT author_identity_id_nonempty_check;
  END IF;

  IF to_regclass('public.idx_author_identity') IS NULL THEN
    CREATE UNIQUE INDEX idx_author_identity
      ON author(identity_provider, identity_id)
      WHERE identity_provider IS NOT NULL AND identity_id IS NOT NULL;
  END IF;
END
$$;
