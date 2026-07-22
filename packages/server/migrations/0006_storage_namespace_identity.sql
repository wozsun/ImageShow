ALTER TABLE storage_backend
  ADD COLUMN IF NOT EXISTS namespace_identities TEXT[] NOT NULL DEFAULT '{}';
