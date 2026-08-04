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
