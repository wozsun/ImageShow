-- ImageShow schema — single initial migration, applied once inside one transaction.
-- PostgreSQL is the source of truth for image metadata, category counts, the theme/tag/
-- author vocabularies, upload sessions, the operation-log job queue, the storage-backend
-- registry and admin accounts. Tables are ordered so each one is defined before anything
-- that references it, which lets metadata declare its foreign keys inline.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Reference tables: storage backends, the slug vocabularies, categories.
-- metadata's foreign keys point at these, so they are created first.
-- ============================================================================

-- Named storage backends. A backend is an instance (its own bucket/credentials), not just
-- a type, so two object-storage backends can coexist (e.g. two buckets). The S3 secret is
-- stored here in plaintext and never returned to the client.
CREATE TABLE IF NOT EXISTS storage_backend (
  slug TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  -- Driver kind: local (container filesystem), s3 (object storage), webdav.
  type TEXT NOT NULL DEFAULT 'local',
  -- Driver settings (S3 endpoint/bucket/keys/... for type='s3'; '{}' for 'local'),
  -- validated by the app's zod schema.
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  is_default BOOLEAN NOT NULL DEFAULT false,
  -- Manual display order on the storage management page (drag-to-sort); ascending. The
  -- built-in 'local' backend is always pinned first by the read query regardless of this.
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(slug) <= 32),
  CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  CHECK (length(display_name) <= 64),
  CHECK (type IN ('local', 's3', 'webdav'))
);

-- Exactly one default backend (the new-upload target), DB-enforced.
CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_backend_default
ON storage_backend((is_default)) WHERE is_default;

-- Built-in local backend = the container filesystem. Seeded as the default so a fresh
-- instance stores locally out of the box and the metadata.storage_slug FK always resolves.
INSERT INTO storage_backend(slug, display_name, type, is_default)
VALUES('local', '本地', 'local', true) ON CONFLICT (slug) DO NOTHING;

-- theme / tag / author are lowercase-ASCII slug vocabularies (URL-safe, usable as query
-- params) with a human display_name (e.g. fddm -> 房东的猫) that also resolves back to the
-- slug in search. An image carries exactly one theme (metadata.theme) and at most one
-- author (metadata.author), but many tags (the image_tag join).

CREATE TABLE IF NOT EXISTS theme (
  slug TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  -- Manual display order on the management page (drag-to-sort); ascending. The 'none'
  -- sentinel is always pinned first regardless of this value.
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(slug) <= 32),
  CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  CHECK (length(display_name) <= 64)
);

-- Reserved sentinel for an unassigned theme: every metadata row defaults to theme='none',
-- so this row must exist for the metadata.theme foreign key. Shown first as '未设置'; it
-- cannot be created, renamed, reordered or deleted in theme management.
INSERT INTO theme(slug, display_name) VALUES('none', '未设置') ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS tag (
  slug TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  -- Manual display order on the tag management page (drag-to-sort); ascending.
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(slug) <= 32),
  CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  CHECK (length(display_name) <= 64)
);

-- author mirrors theme/tag (slug + display_name + sort_order) plus a link column — an
-- optional http(s) URL for the author's page, shown on the image detail view. An image's
-- author is optional and nullable (no 'none' sentinel) and does NOT take part in category
-- keys, so changing it is a plain field edit with no re-index. No sentinel row: an
-- unassigned image has author = NULL; authors are created in author management or on the
-- fly by the upload / link / edit write paths (ensureAuthor).
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

-- One row per (device, brightness, theme) bucket holding the live image count;
-- metadata.category_key references it, and count drives pagination and stats.
CREATE TABLE IF NOT EXISTS category (
  category_key TEXT PRIMARY KEY,
  device TEXT NOT NULL,
  brightness TEXT NOT NULL,
  theme TEXT NOT NULL DEFAULT 'none',
  count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (device IN ('pc', 'mb')),
  CHECK (brightness IN ('dark', 'light')),
  CHECK (theme <> ''),
  CHECK (length(theme) <= 32),
  CHECK (theme ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  CHECK (category_key = device || '-' || brightness || '-' || theme),
  CHECK (count >= 0)
);

-- ============================================================================
-- Core image table and its tag join.
-- ============================================================================

CREATE TABLE IF NOT EXISTS metadata (
  id UUID PRIMARY KEY,
  -- Categorization: category_key = '<device>-<brightness>-<theme>' and index_key adds the
  -- per-category running index — both DB-derived/validated (see the CHECKs below).
  device TEXT NOT NULL,
  brightness TEXT NOT NULL,
  theme TEXT NOT NULL DEFAULT 'none',
  category_key TEXT NOT NULL,
  category_index INTEGER NOT NULL,
  index_key TEXT NOT NULL,
  -- Stored file & backend. object_key is the storage key for uploads, or the external URL
  -- for link images (is_link=true) — in which case only the thumbnail is hosted, on
  -- storage_slug under the top-level link/ prefix.
  ext TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  is_link BOOLEAN NOT NULL DEFAULT false,
  storage_slug TEXT NOT NULL DEFAULT 'local',
  md5 TEXT NOT NULL DEFAULT '',
  -- Pixel dimensions and byte sizes for storage-usage stats. image_size is the original's
  -- bytes (0 for link images — their original is external); thumbnail_size is the generated
  -- thumbnail's bytes (the only hosted bytes for a link image). Both 0 until the bytes exist.
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  image_size BIGINT NOT NULL DEFAULT 0,
  thumbnail_size BIGINT NOT NULL DEFAULT 0,
  -- Descriptive / attribution. author is optional (NULL = no author).
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  original TEXT NOT NULL DEFAULT '',
  author TEXT,
  -- Lifecycle: status flips to 'deleted' (soft delete); the original and thumbnail stay in
  -- place (objects/ + thumbs/) until the row is purged from the recycle bin.
  status TEXT NOT NULL DEFAULT 'ready',
  deleted_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (device IN ('pc', 'mb')),
  CHECK (brightness IN ('dark', 'light')),
  CHECK (theme <> ''),
  CHECK (length(theme) <= 32),
  CHECK (theme ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  CHECK (category_key = device || '-' || brightness || '-' || theme),
  CHECK (category_index >= 1),
  CHECK (ext IN ('jpg', 'png', 'webp', 'gif', 'avif')),
  CHECK (md5 = '' OR md5 ~ '^[a-f0-9]{32}$'),
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
  -- Real referential integrity — the DB backstop behind the service-layer guards. RESTRICT
  -- (never CASCADE) so a theme / category / backend in use by live images can't be removed
  -- out from under them; the write paths register the theme (ensureTheme), category
  -- (upsertCategory) and author (ensureAuthor) before inserting/repointing a row, so these
  -- never fire in normal operation. author uses SET NULL (it's optional): deleting an author
  -- just clears it from its images instead of blocking the delete.
  CONSTRAINT fk_metadata_theme    FOREIGN KEY (theme)        REFERENCES theme(slug)            ON DELETE RESTRICT,
  CONSTRAINT fk_metadata_category FOREIGN KEY (category_key) REFERENCES category(category_key) ON DELETE RESTRICT,
  CONSTRAINT fk_metadata_storage  FOREIGN KEY (storage_slug) REFERENCES storage_backend(slug)  ON DELETE RESTRICT,
  CONSTRAINT fk_metadata_author   FOREIGN KEY (author)       REFERENCES author(slug)           ON DELETE SET NULL
);

-- One ready image per index_key and per (category_key, category_index); deleted rows are
-- exempt, so a recycle-bin row can keep the former occupant of a now-reused slot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_metadata_ready_index_key
ON metadata(index_key) WHERE status = 'ready';

CREATE UNIQUE INDEX IF NOT EXISTS idx_metadata_ready_category_index
ON metadata(category_key, category_index) WHERE status = 'ready';

CREATE INDEX IF NOT EXISTS idx_metadata_category
ON metadata(category_key, category_index);

CREATE INDEX IF NOT EXISTS idx_metadata_status_deleted
ON metadata(status, deleted_at, id);

CREATE INDEX IF NOT EXISTS idx_metadata_status_created_at
ON metadata(status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_metadata_md5
ON metadata(md5) WHERE md5 <> '';

-- Lets the on-demand md5 backfill skip a full table scan once every row is hashed.
CREATE INDEX IF NOT EXISTS idx_metadata_missing_md5
ON metadata(id) WHERE md5 = '';

-- Serves the thumbnail fallback lookup that maps an object key to its .webp key.
CREATE INDEX IF NOT EXISTS idx_metadata_thumb_key
ON metadata((regexp_replace(object_key, '\.[^/.]+$', '.webp')));

-- Back the metadata.theme / author / storage_slug foreign keys' referential checks (a
-- delete on the parent must scan for referencing rows), plus theme/author filters and
-- per-backend stats. Non-partial on purpose so the FK check sees rows of every status.
CREATE INDEX IF NOT EXISTS idx_metadata_theme ON metadata(theme);
CREATE INDEX IF NOT EXISTS idx_metadata_author ON metadata(author);
CREATE INDEX IF NOT EXISTS idx_metadata_storage_slug ON metadata(storage_slug);

CREATE TABLE IF NOT EXISTS image_tag (
  image_id UUID NOT NULL REFERENCES metadata(id) ON DELETE CASCADE,
  tag_slug TEXT NOT NULL REFERENCES tag(slug) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (image_id, tag_slug)
);

-- Reverse lookup: which images carry a given tag.
CREATE INDEX IF NOT EXISTS idx_image_tag_tag ON image_tag(tag_slug, image_id);

-- ============================================================================
-- Operational tables (no foreign keys into metadata).
-- ============================================================================

CREATE TABLE IF NOT EXISTS upload_session (
  id UUID PRIMARY KEY,
  staging_object_key TEXT NOT NULL UNIQUE,
  final_object_key TEXT NOT NULL DEFAULT '',
  -- Upload target backend (a storage_backend.slug). Deliberately NOT FK'd: a finalized
  -- session lingers with its storage_slug, so a hard FK would make any backend ever
  -- uploaded to permanently undeletable. An upload to a since-deleted backend just fails at
  -- finalize (the slug no longer resolves), which is acceptable.
  storage_slug TEXT NOT NULL DEFAULT 'local',
  expected_size BIGINT NOT NULL,
  metadata_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'created',
  idempotency_key TEXT NOT NULL UNIQUE,
  error TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expected_size > 0),
  CHECK (status IN ('created', 'finalizing', 'finalized', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_upload_session_status_expires
ON upload_session(status, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_upload_session_final_object_key
ON upload_session(final_object_key) WHERE final_object_key <> '';

-- Durable job queue for async/idempotent background work (thumbnail generation, storage-move
-- cleanup, cache rebuild, upload cleanup), retried with backoff by the worker.
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
  CHECK (type IN ('thumb.generate','move.cleanup','upload.cleanup','cache.rebuild')),
  CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'ignored'))
);

CREATE INDEX IF NOT EXISTS idx_operation_log_status
ON operation_log(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_operation_log_target
ON operation_log(target_id, type);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operation_log_idempotency
ON operation_log(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- At most one active cache.rebuild (pending or running) at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_operation_log_active_cache_rebuild
ON operation_log(type) WHERE type = 'cache.rebuild' AND status IN ('pending', 'running');

-- Generic singleton key/value settings; currently unused, kept for future small singletons.
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_account (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'image',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (role IN ('super', 'image'))
);

-- At most one super-admin. It is provisioned (and force-resynced when changed) only from
-- the ADMIN_USERNAME/ADMIN_PASSWORD env vars, so a lost password is recoverable by
-- redeploying. Image admins are created in the UI and manage images/uploads/tags/themes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_single_super
ON admin_account((role)) WHERE role = 'super';
