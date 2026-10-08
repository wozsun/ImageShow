-- One-time upgrade from the 6.7.9 schema; removed in 6.8.1.
CREATE TABLE image_group (
  slug TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(slug) <= 32),
  CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  CHECK (length(display_name) <= 64)
);

CREATE TABLE image_group_member (
  group_slug TEXT NOT NULL REFERENCES image_group(slug) ON DELETE CASCADE,
  image_id UUID NOT NULL REFERENCES metadata(id) ON DELETE CASCADE,
  PRIMARY KEY (group_slug, image_id)
);
CREATE INDEX idx_image_group_member_image ON image_group_member(image_id);

ALTER TABLE ready_image_revision RENAME TO projection_revision;
