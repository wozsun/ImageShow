ALTER TABLE metadata
  ADD COLUMN IF NOT EXISTS purge_state TEXT NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS purge_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS purge_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS purge_error TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'metadata_purge_state_check'
      AND conrelid = 'metadata'::regclass
  ) THEN
    ALTER TABLE metadata
      ADD CONSTRAINT metadata_purge_state_check
      CHECK (purge_state IN ('idle', 'purging', 'failed'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_metadata_trash_purge
ON metadata(purge_state, deleted_at, id)
WHERE status = 'deleted';
