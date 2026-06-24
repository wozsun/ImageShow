CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS metadata (
  id UUID PRIMARY KEY,
  device TEXT NOT NULL DEFAULT 'none',
  brightness TEXT NOT NULL DEFAULT 'none',
  theme TEXT NOT NULL DEFAULT 'none',
  category_key TEXT NOT NULL,
  category_index INTEGER NOT NULL,
  index_key TEXT NOT NULL,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  ext TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  original TEXT NOT NULL DEFAULT '',
  md5 TEXT NOT NULL DEFAULT '',
  storage_backend TEXT NOT NULL DEFAULT 'local',
  status TEXT NOT NULL DEFAULT 'ready',
  deleted_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (device IN ('pc', 'mb', 'none')),
  CHECK (brightness IN ('dark', 'light', 'none')),
  CHECK (theme <> ''),
  CHECK (length(theme) <= 32),
  CHECK (theme ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  CHECK (ext IN ('jpg', 'png', 'webp', 'gif', 'avif')),
  CHECK (length(source) <= 2048),
  CHECK (length(original) <= 2048),
  CHECK (original = '' OR original ~* '^https?://'),
  CHECK (md5 = '' OR md5 ~ '^[a-f0-9]{32}$'),
  CHECK (category_key = device || '-' || brightness || '-' || theme),
  CHECK (category_index >= 1),
  CHECK (width >= 0),
  CHECK (height >= 0),
  CHECK (status IN ('ready', 'deleted')),
  CHECK (storage_backend IN ('local', 's3', 'webdav'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_metadata_ready_index_key
ON metadata(index_key)
WHERE status = 'ready';

CREATE UNIQUE INDEX IF NOT EXISTS idx_metadata_ready_category_index
ON metadata(category_key, category_index)
WHERE status = 'ready';

CREATE INDEX IF NOT EXISTS idx_metadata_category
ON metadata(category_key, category_index);

CREATE INDEX IF NOT EXISTS idx_metadata_status_deleted
ON metadata(status, deleted_at, id);

CREATE INDEX IF NOT EXISTS idx_metadata_status_created_at
ON metadata(status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_metadata_md5
ON metadata(md5)
WHERE md5 <> '';

-- Lets the on-demand md5 backfill skip a full table scan once every row is hashed.
CREATE INDEX IF NOT EXISTS idx_metadata_missing_md5
ON metadata(id)
WHERE md5 = '';

-- Serves the thumbnail fallback lookup that maps an object key to its .webp key.
CREATE INDEX IF NOT EXISTS idx_metadata_thumb_key
ON metadata((regexp_replace(object_key, '\.[^/.]+$', '.webp')));

CREATE TABLE IF NOT EXISTS category (
  category_key TEXT PRIMARY KEY,
  device TEXT NOT NULL DEFAULT 'none',
  brightness TEXT NOT NULL DEFAULT 'none',
  theme TEXT NOT NULL DEFAULT 'none',
  count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (device IN ('pc', 'mb', 'none')),
  CHECK (brightness IN ('dark', 'light', 'none')),
  CHECK (theme <> ''),
  CHECK (length(theme) <= 32),
  CHECK (theme ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  CHECK (category_key = device || '-' || brightness || '-' || theme),
  CHECK (count >= 0)
);

CREATE TABLE IF NOT EXISTS upload_session (
  id UUID PRIMARY KEY,
  staging_object_key TEXT NOT NULL UNIQUE,
  final_object_key TEXT NOT NULL DEFAULT '',
  storage_backend TEXT NOT NULL DEFAULT 'local',
  expected_size BIGINT NOT NULL,
  metadata_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'created',
  idempotency_key TEXT NOT NULL UNIQUE,
  error TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expected_size > 0),
  CHECK (storage_backend IN ('local', 's3', 'webdav')),
  CHECK (status IN ('created', 'finalizing', 'finalized', 'expired', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_upload_session_status_expires
ON upload_session(status, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_upload_session_final_object_key
ON upload_session(final_object_key)
WHERE final_object_key <> '';

CREATE TABLE IF NOT EXISTS operation_log (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL,
  target_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT DEFAULT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT NOT NULL DEFAULT '',
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (type IN ('delete.finalize','restore.finalize','move.cleanup','empty-trash','upload.cleanup','cache.rebuild','thumb.generate')),
  CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'ignored'))
);

CREATE INDEX IF NOT EXISTS idx_operation_log_status
ON operation_log(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_operation_log_target
ON operation_log(target_id, type);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operation_log_idempotency
ON operation_log(idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_operation_log_active_cache_rebuild
ON operation_log(type)
WHERE type = 'cache.rebuild' AND status IN ('pending', 'running');

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DELETE FROM app_config
WHERE key <> 'storage';

CREATE TABLE IF NOT EXISTS admin_account (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
