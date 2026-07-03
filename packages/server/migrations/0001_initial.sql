CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage_backend (
  slug TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'local',
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  is_default BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(slug) <= 32),
  CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  CHECK (length(display_name) <= 64),
  CHECK (type IN ('local', 's3', 'webdav'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_backend_default
ON storage_backend((is_default)) WHERE is_default;

INSERT INTO storage_backend(slug, display_name, type, is_default)
VALUES('local', '本地', 'local', true) ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS theme (
  slug TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(slug) <= 32),
  CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  CHECK (length(display_name) <= 64)
);

INSERT INTO theme(slug, display_name) VALUES('none', '未设置') ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS tag (
  slug TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(slug) <= 32),
  CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  CHECK (length(display_name) <= 64)
);

CREATE TABLE IF NOT EXISTS author (
  slug TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(slug) <= 32),
  CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  CHECK (length(display_name) <= 64),
  CHECK (length(link) <= 2048),
  CHECK (link = '' OR link ~* '^https?://')
);

CREATE TABLE IF NOT EXISTS metadata (
  id UUID PRIMARY KEY,
  device TEXT NOT NULL,
  brightness TEXT NOT NULL,
  theme TEXT NOT NULL DEFAULT 'none',
  ext TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  is_link BOOLEAN NOT NULL DEFAULT false,
  storage_slug TEXT NOT NULL DEFAULT 'local',
  md5 TEXT NOT NULL,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  image_size BIGINT NOT NULL DEFAULT 0,
  thumbnail_size BIGINT NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  original TEXT NOT NULL DEFAULT '',
  author TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  deleted_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (device IN ('pc', 'mb')),
  CHECK (brightness IN ('dark', 'light')),
  CHECK (theme <> ''),
  CHECK (length(theme) <= 32),
  CHECK (theme ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  CHECK (ext IN ('jpg', 'png', 'webp', 'gif', 'avif')),
  CHECK (md5 ~ '^[a-f0-9]{32}$'),
  CHECK (width >= 0),
  CHECK (height >= 0),
  CHECK (image_size >= 0),
  CHECK (thumbnail_size >= 0),
  CHECK (length(source) <= 2048),
  CHECK (length(original) <= 2048),
  CHECK (original = '' OR original ~* '^https?://'),
  CHECK (author <> ''),
  CHECK (length(author) <= 32),
  CHECK (author ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  CHECK (status IN ('ready', 'deleted')),
  CONSTRAINT fk_metadata_theme    FOREIGN KEY (theme)        REFERENCES theme(slug)            ON DELETE RESTRICT,
  CONSTRAINT fk_metadata_storage  FOREIGN KEY (storage_slug) REFERENCES storage_backend(slug)  ON DELETE RESTRICT,
  CONSTRAINT fk_metadata_author   FOREIGN KEY (author)       REFERENCES author(slug)           ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_metadata_ready_random_axes
ON metadata(device, brightness, theme, id) WHERE status = 'ready';

CREATE INDEX IF NOT EXISTS idx_metadata_status_deleted
ON metadata(status, deleted_at, id);

CREATE INDEX IF NOT EXISTS idx_metadata_status_created_at
ON metadata(status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_metadata_md5
ON metadata(md5);

CREATE INDEX IF NOT EXISTS idx_metadata_thumb_key
ON metadata((regexp_replace(object_key, '\.[^/.]+$', '.webp')));

CREATE INDEX IF NOT EXISTS idx_metadata_theme ON metadata(theme);
CREATE INDEX IF NOT EXISTS idx_metadata_author ON metadata(author);
CREATE INDEX IF NOT EXISTS idx_metadata_storage_slug ON metadata(storage_slug);

CREATE TABLE IF NOT EXISTS image_tag (
  image_id UUID NOT NULL REFERENCES metadata(id) ON DELETE CASCADE,
  tag_slug TEXT NOT NULL REFERENCES tag(slug) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (image_id, tag_slug)
);

CREATE INDEX IF NOT EXISTS idx_image_tag_tag ON image_tag(tag_slug, image_id);

-- ============================================================================

CREATE TABLE IF NOT EXISTS import_session (
  id UUID PRIMARY KEY,
  mode TEXT NOT NULL,
  final_object_key TEXT NOT NULL DEFAULT '',
  storage_slug TEXT NOT NULL DEFAULT 'local',
  source_url TEXT NOT NULL DEFAULT '',
  expected_size BIGINT,
  metadata_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  prepared_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'created',
  idempotency_key TEXT NOT NULL UNIQUE,
  error TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (mode IN ('upload', 'download', 'proxy')),
  CHECK (expected_size IS NULL OR expected_size > 0),
  CHECK (source_url = '' OR source_url ~* '^https?://'),
  CHECK (status IN ('created', 'receiving', 'preparing', 'ready', 'committing', 'finalized', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_import_session_status_expires
ON import_session(status, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_import_session_final_object_key
ON import_session(final_object_key) WHERE final_object_key <> '';

CREATE TABLE IF NOT EXISTS background_job (
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
  CHECK (type IN ('thumb.generate','move.cleanup','upload.cleanup','cache.rebuild')),
  CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'ignored'))
);

CREATE INDEX IF NOT EXISTS idx_background_job_status
ON background_job(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_background_job_target
ON background_job(target_id, type);

CREATE UNIQUE INDEX IF NOT EXISTS idx_background_job_idempotency
ON background_job(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_background_job_active_cache_rebuild
ON background_job(type) WHERE type = 'cache.rebuild' AND status IN ('pending', 'running');

CREATE TABLE IF NOT EXISTS admin_account (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'image',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (role IN ('super', 'image'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_single_super
ON admin_account((role)) WHERE role = 'super';
