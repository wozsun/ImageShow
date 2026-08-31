-- ImageShow clean-install schema.
-- This schema creates no migration ledger or persistent version marker.

-- Storage registry
CREATE TABLE storage_backend (
  slug TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'local',
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  namespace_identities TEXT[] NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  is_default BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(slug) <= 32),
  CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  CHECK (length(display_name) <= 64),
  CHECK (type IN ('local', 's3'))
);

CREATE UNIQUE INDEX idx_storage_backend_default
ON storage_backend((is_default)) WHERE is_default;

INSERT INTO storage_backend(slug, display_name, type, is_default)
VALUES('local', '本地', 'local', true);

-- Public vocabularies
CREATE TABLE theme (
  slug TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(slug) <= 32),
  CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  CHECK (length(display_name) <= 64)
);

INSERT INTO theme(slug, display_name) VALUES('none', '未设置');

CREATE TABLE tag (
  slug TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(slug) <= 32),
  CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  CHECK (length(display_name) <= 64)
);

CREATE TABLE author (
  slug TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  identity_provider TEXT,
  identity_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(slug) <= 32),
  CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  CHECK (length(display_name) <= 64),
  CHECK (length(link) <= 2048),
  CHECK (link = '' OR link ~* '^https://'),
  CONSTRAINT author_identity_pair_check CHECK (
    (identity_provider IS NULL AND identity_id IS NULL)
    OR (identity_provider IS NOT NULL AND identity_id IS NOT NULL)
  ),
  CONSTRAINT author_identity_provider_token_check CHECK (
    identity_provider IS NULL
    OR (
      char_length(identity_provider) BETWEEN 1 AND 32
      AND identity_provider ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    )
  ),
  CONSTRAINT author_identity_id_nonempty_check CHECK (
    identity_id IS NULL OR char_length(identity_id) > 0
  )
);

CREATE UNIQUE INDEX idx_author_identity
ON author(identity_provider, identity_id)
WHERE identity_provider IS NOT NULL AND identity_id IS NOT NULL;

-- Image truth and relations
CREATE TABLE metadata (
  id UUID PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'ready',
  storage_slug TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  device TEXT NOT NULL,
  brightness TEXT NOT NULL,
  theme TEXT NOT NULL DEFAULT 'none',
  author TEXT,
  ext TEXT NOT NULL,
  md5 TEXT NOT NULL,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  image_size BIGINT NOT NULL DEFAULT 0,
  thumbnail_size BIGINT NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  original TEXT NOT NULL DEFAULT '',
  image_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  purge_job_id UUID,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status IN ('ready', 'deleted')),
  CHECK (device IN ('pc', 'mb')),
  CHECK (brightness IN ('dark', 'light')),
  CHECK (theme <> ''),
  CHECK (length(theme) <= 32),
  CHECK (theme ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  CHECK (author <> ''),
  CHECK (length(author) <= 32),
  CHECK (author ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  CHECK (ext IN ('jpg', 'png', 'webp', 'gif', 'avif')),
  CHECK (md5 ~ '^[a-f0-9]{32}$'),
  CHECK (width >= 0),
  CHECK (height >= 0),
  CHECK (image_size >= 0),
  CHECK (thumbnail_size >= 0),
  CHECK (length(source) <= 2048),
  CHECK (source = '' OR source ~* '^https://'),
  CHECK (length(original) <= 2048),
  CHECK (original = '' OR original ~* '^https://'),
  CONSTRAINT metadata_purge_job_deleted_check
    CHECK (purge_job_id IS NULL OR status='deleted'),
  CONSTRAINT fk_metadata_storage  FOREIGN KEY (storage_slug) REFERENCES storage_backend(slug)  ON DELETE RESTRICT,
  CONSTRAINT fk_metadata_theme    FOREIGN KEY (theme)        REFERENCES theme(slug)            ON DELETE RESTRICT,
  CONSTRAINT fk_metadata_author   FOREIGN KEY (author)       REFERENCES author(slug)           ON DELETE SET NULL
);

-- Direct lookups and foreign-key support
CREATE INDEX idx_metadata_storage_slug ON metadata(storage_slug);
CREATE INDEX idx_metadata_theme ON metadata(theme);
CREATE INDEX idx_metadata_author ON metadata(author);

CREATE INDEX idx_metadata_md5
ON metadata(md5);

CREATE INDEX idx_metadata_thumb_key
ON metadata((regexp_replace(object_key, '\.[^/.]+$', '.webp')));

-- State and gallery cursor reads
CREATE INDEX idx_metadata_status_deleted
ON metadata(status, deleted_at, id);

CREATE INDEX idx_metadata_status_image_time
ON metadata(status, image_time DESC, id DESC);

CREATE INDEX idx_metadata_ready_image_time
ON metadata(image_time DESC, id DESC) WHERE status = 'ready';

CREATE INDEX idx_metadata_ready_device_image_time
ON metadata(device, image_time DESC, id DESC) WHERE status = 'ready';

CREATE INDEX idx_metadata_ready_brightness_image_time
ON metadata(brightness, image_time DESC, id DESC) WHERE status = 'ready';

CREATE INDEX idx_metadata_ready_device_brightness_image_time
ON metadata(device, brightness, image_time DESC, id DESC) WHERE status = 'ready';

CREATE INDEX idx_metadata_ready_device_theme_image_time
ON metadata(device, theme, image_time DESC, id DESC) WHERE status = 'ready';

CREATE INDEX idx_metadata_ready_brightness_theme_image_time
ON metadata(brightness, theme, image_time DESC, id DESC) WHERE status = 'ready';

CREATE INDEX idx_metadata_ready_axes_image_time
ON metadata(device, brightness, theme, image_time DESC, id DESC) WHERE status = 'ready';

CREATE INDEX idx_metadata_ready_theme_image_time
ON metadata(theme, image_time DESC, id DESC) WHERE status = 'ready';

CREATE INDEX idx_metadata_ready_author_image_time
ON metadata(author, image_time DESC, id DESC) WHERE status = 'ready';

-- Random selection
CREATE INDEX idx_metadata_ready_random_axes
ON metadata(device, brightness, theme, id) WHERE status = 'ready';

CREATE INDEX idx_metadata_ready_id_suffix
ON metadata ((right(id::text, 12))) WHERE status = 'ready';

CREATE TABLE image_tag (
  image_id UUID NOT NULL REFERENCES metadata(id) ON DELETE CASCADE,
  tag_slug TEXT NOT NULL REFERENCES tag(slug) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (image_id, tag_slug)
);

CREATE INDEX idx_image_tag_tag ON image_tag(tag_slug, image_id);

-- One PostgreSQL-owned revision validates the entire rebuildable image cache.
-- Redis never becomes authoritative; cache-affecting business transactions
-- increment this row before COMMIT.
CREATE TABLE ready_image_revision (
  singleton SMALLINT PRIMARY KEY DEFAULT 1,
  revision BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (singleton = 1),
  CHECK (revision >= 0)
);

INSERT INTO ready_image_revision(singleton, revision)
VALUES (1, 0);

-- Background work queue
CREATE TABLE background_job (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  execution_token UUID,
  target_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT NOT NULL DEFAULT '',
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT background_job_current_type_check
    CHECK (type IN ('move.cleanup', 'trash.purge', 'cache.rebuild')),
  CHECK (status IN ('pending', 'running', 'succeeded', 'failed'))
);

CREATE INDEX idx_background_job_status
ON background_job(status, updated_at);

CREATE UNIQUE INDEX idx_background_job_active_cache_rebuild
ON background_job(type) WHERE type = 'cache.rebuild' AND status IN ('pending', 'running');

CREATE INDEX idx_background_job_target
ON background_job(target_id, type);

CREATE UNIQUE INDEX idx_background_job_idempotency
ON background_job(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Administrative identities
CREATE TABLE admin_account (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'image',
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (role IN ('super', 'image')),
  CHECK (
    char_length(password_hash) BETWEEN 64 AND 512
    AND password_hash ~ '^\$argon2id\$v=[0-9]+\$m=[0-9]+,t=[0-9]+,p=[0-9]+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$'
  ),
  CONSTRAINT admin_account_preferences_object_check
    CHECK (jsonb_typeof(preferences) = 'object'),
  CONSTRAINT admin_account_preferences_size_check
    CHECK (octet_length(preferences::text) <= 4096)
);

CREATE UNIQUE INDEX idx_admin_single_super
ON admin_account((role)) WHERE role = 'super';
