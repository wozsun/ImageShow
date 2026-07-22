ALTER TABLE admin_account
  ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'admin_account'::regclass
      AND conname = 'admin_account_preferences_object_check'
  ) THEN
    ALTER TABLE admin_account
      ADD CONSTRAINT admin_account_preferences_object_check
      CHECK (jsonb_typeof(preferences) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'admin_account'::regclass
      AND conname = 'admin_account_preferences_size_check'
  ) THEN
    ALTER TABLE admin_account
      ADD CONSTRAINT admin_account_preferences_size_check
      CHECK (octet_length(preferences::text) <= 4096);
  END IF;
END $$;
