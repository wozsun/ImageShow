import type { PoolClient } from "pg";
import { slugPattern, type Brightness, type Device } from "@imageshow/shared";
import { pool, withTransaction } from "../core/db.js";
import { ApiError } from "../core/http.js";
import { getRuntimeConfig } from "../config/env.js";
import { mapWithConcurrency } from "../core/concurrency.js";
import { invalidateImageReadCaches } from "../images/image-cache.js";
import { rebuildRandomPool } from "../random/random-cache.js";
import { invalidateThemeVocab } from "../vocab/vocab-cache.js";
import { linkThumbnailKey, storageObjectKey, thumbnailObjectKey } from "../storage/image-paths.js";
import { copyObject, pruneEmptyStorageDirs, removeObject } from "../storage/storage.js";

export async function ensureTheme(client: PoolClient, slug: string) {
  if (!slug || slug === "none") return;
  await client.query(
    "INSERT INTO theme(slug, sort_order) VALUES($1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM theme)) ON CONFLICT (slug) DO NOTHING",
    [slug]
  );
}

export async function createTheme(slug: string, displayName: string) {
  if (slug === "none" || slug.length > 32 || !slugPattern.test(slug)) {
    throw new ApiError(400, "invalid_theme", "Theme slug must be a lowercase slug (a-z, 0-9, -), <=32 chars", { slug });
  }

  await pool.query(
    `INSERT INTO theme(slug, display_name, sort_order)
     VALUES($1, $2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM theme))
     ON CONFLICT (slug) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()`,
    [slug, displayName]
  );
  await invalidateThemeVocab();
}

export async function setThemeDisplayName(slug: string, displayName: string) {
  if (slug === "none") throw new ApiError(400, "invalid_theme", "The reserved 'none' theme cannot be renamed", { slug });
  const result = await pool.query("UPDATE theme SET display_name = $2, updated_at = now() WHERE slug = $1", [slug, displayName]);
  if (!result.rowCount) throw new ApiError(404, "not_found", "Theme not found");
  await invalidateThemeVocab();
}

export async function reorderThemes(slugs: string[]) {
  if (!slugs.length) return;
  await pool.query(
    `UPDATE theme t SET sort_order = v.ord, updated_at = now()
     FROM unnest($1::text[]) WITH ORDINALITY AS v(slug, ord)
     WHERE t.slug = v.slug AND t.slug <> 'none'`,
    [slugs]
  );
  await invalidateThemeVocab();
}

async function reassignThemeImagesToNone(theme: string): Promise<boolean> {
  const images = (await pool.query(
    "SELECT id, device, brightness, ext, object_key, storage_slug, is_link, status FROM metadata WHERE theme=$1 ORDER BY device, brightness, id",
    [theme]
  )).rows as Array<{ id: string; device: Device; brightness: Brightness; ext: string; object_key: string; storage_slug: string; is_link: boolean; status: string }>;
  if (!images.length) return false;

  const moves = images
    .filter((image) => !image.is_link)
    .map((image) => ({ ...image, newKey: storageObjectKey(image.device, image.brightness, "none", image.id, image.ext) }))
    .filter((move) => move.newKey !== move.object_key);
  const newKeyById = new Map(moves.map((move) => [move.id, move.newKey]));

  const linkThumbMoves = images
    .filter((image) => image.is_link)
    .map((image) => ({
      storage_slug: image.storage_slug,
      oldThumbKey: linkThumbnailKey(image.device, image.brightness, theme, image.id),
      newThumbKey: linkThumbnailKey(image.device, image.brightness, "none", image.id)
    }))
    .filter((move) => move.oldThumbKey !== move.newThumbKey);
  const concurrency = getRuntimeConfig().background_job.theme_reassign_concurrency;

  await mapWithConcurrency(moves, concurrency, async (move) => {
    await copyObject("media", move.object_key, "media", move.newKey, move.storage_slug);
    await copyObject("thumbs", thumbnailObjectKey(move.object_key), "thumbs", thumbnailObjectKey(move.newKey), move.storage_slug);
  });

  await mapWithConcurrency(linkThumbMoves, concurrency, async (move) => {
    await copyObject("link", move.oldThumbKey, "link", move.newThumbKey, move.storage_slug);
  });

  await withTransaction(async (client) => {
    const locked = (await client.query("SELECT id FROM metadata WHERE theme=$1 FOR UPDATE", [theme])).rows as Array<{ id: string }>;
    if (!locked.length) return;
    for (const row of locked) {
      await client.query(
        "UPDATE metadata SET theme='none', object_key=COALESCE($2, object_key), updated_at=now() WHERE id=$1",
        [row.id, newKeyById.get(row.id) ?? null]
      );
    }
  });

  await mapWithConcurrency(moves, concurrency, async (move) => {
    await removeObject("media", move.object_key, move.storage_slug).catch(() => undefined);
    await removeObject("thumbs", thumbnailObjectKey(move.object_key), move.storage_slug).catch(() => undefined);
  });
  await mapWithConcurrency(linkThumbMoves, concurrency, async (move) => {
    await removeObject("link", move.oldThumbKey, move.storage_slug).catch(() => undefined);
  });
  for (const slug of new Set([...moves, ...linkThumbMoves].map((move) => move.storage_slug))) {
    await pruneEmptyStorageDirs(slug).catch(() => undefined);
  }
  return true;
}

export async function deleteTheme(slug: string) {
  if (slug === "none") {
    throw new ApiError(400, "invalid_theme", "The reserved 'none' theme cannot be deleted", { slug });
  }
  const exists = (await pool.query("SELECT 1 FROM theme WHERE slug=$1", [slug])).rowCount;
  if (!exists) throw new ApiError(404, "not_found", "Theme not found");

  const moved = await reassignThemeImagesToNone(slug);
  await pool.query("DELETE FROM theme WHERE slug = $1", [slug]);
  await invalidateThemeVocab();
  if (moved) {
    await rebuildRandomPool();
    await invalidateImageReadCaches();
  }
}

export async function deleteThemes(slugs: string[]) {
  const targets = [...new Set(slugs)].filter((slug) => slug !== "none");
  if (!targets.length) return { deleted: 0 };
  let moved = false;
  let deleted = 0;
  for (const slug of targets) {
    if (!(await pool.query("SELECT 1 FROM theme WHERE slug=$1", [slug])).rowCount) continue;
    if (await reassignThemeImagesToNone(slug)) moved = true;
    deleted += (await pool.query("DELETE FROM theme WHERE slug=$1", [slug])).rowCount ?? 0;
  }
  await invalidateThemeVocab();
  if (moved) {
    await rebuildRandomPool();
    await invalidateImageReadCaches();
  }
  return { deleted };
}
