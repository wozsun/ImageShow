import type { PoolClient } from "pg";
import { categoryKey, indexKey, slugPattern, type Brightness, type Device } from "@imageshow/shared";
import { cleanupEmptyCategories, pool, upsertCategory, withTransaction } from "../core/db.js";
import { ApiError } from "../core/http.js";
import { getRuntimeConfig } from "../config/env.js";
import { mapWithConcurrency } from "../core/concurrency.js";
import { invalidateImageReadCaches, invalidateThemeVocab, rebuildFolderMap } from "../core/redis.js";
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
    "SELECT id, device, brightness, ext, object_key, storage_slug, is_link, status FROM metadata WHERE theme=$1 ORDER BY device, brightness, category_index",
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
  const concurrency = getRuntimeConfig().operation_log.theme_reassign_concurrency;

  await mapWithConcurrency(moves, concurrency, async (move) => {
    await copyObject("objects", move.object_key, "objects", move.newKey, move.storage_slug);
    await copyObject("thumbs", thumbnailObjectKey(move.object_key), "thumbs", thumbnailObjectKey(move.newKey), move.storage_slug);
  });

  await mapWithConcurrency(linkThumbMoves, concurrency, async (move) => {
    await copyObject("link", move.oldThumbKey, "link", move.newThumbKey, move.storage_slug);
  });

  await withTransaction(async (client) => {
    const ready = (await client.query(
      "SELECT id, device, brightness FROM metadata WHERE theme=$1 AND status='ready' ORDER BY device, brightness, category_index FOR UPDATE",
      [theme]
    )).rows as Array<{ id: string; device: Device; brightness: Brightness }>;
    const deleted = (await client.query(
      "SELECT id, device, brightness FROM metadata WHERE theme=$1 AND status='deleted' FOR UPDATE",
      [theme]
    )).rows as Array<{ id: string; device: Device; brightness: Brightness }>;

    const nextIndex = new Map<string, number>();
    for (const row of ready) {
      const target = categoryKey(row.device, row.brightness, "none");
      if (!nextIndex.has(target)) {
        await upsertCategory(client, target, row.device, row.brightness, "none");
        const count = Number((await client.query("SELECT count FROM category WHERE category_key=$1 FOR UPDATE", [target])).rows[0].count);
        nextIndex.set(target, count);
      }
      const idx = nextIndex.get(target)! + 1;
      nextIndex.set(target, idx);
      await client.query(
        "UPDATE metadata SET theme='none', category_key=$2, category_index=$3, index_key=$4, object_key=COALESCE($5,object_key), updated_at=now() WHERE id=$1",
        [row.id, target, idx, indexKey(target, idx), newKeyById.get(row.id) ?? null]
      );
    }
    for (const [target, count] of nextIndex) {
      await client.query("UPDATE category SET count=$2, updated_at=now() WHERE category_key=$1", [target, count]);
    }

    await client.query("UPDATE category SET count=0, updated_at=now() WHERE theme=$1", [theme]);

    for (const row of deleted) {
      const target = categoryKey(row.device, row.brightness, "none");
      await upsertCategory(client, target, row.device, row.brightness, "none");
      await client.query(
        "UPDATE metadata SET theme='none', category_key=$2, object_key=COALESCE($3,object_key), updated_at=now() WHERE id=$1",
        [row.id, target, newKeyById.get(row.id) ?? null]
      );
    }
  });

  await mapWithConcurrency(moves, concurrency, async (move) => {
    await removeObject("objects", move.object_key, move.storage_slug).catch(() => undefined);
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
  if (moved) { await cleanupEmptyCategories(); await rebuildFolderMap(); await invalidateImageReadCaches(); }
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
  if (moved) { await cleanupEmptyCategories(); await rebuildFolderMap(); await invalidateImageReadCaches(); }
  return { deleted };
}
