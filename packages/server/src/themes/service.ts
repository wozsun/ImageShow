import type { PoolClient } from "pg";
import { categoryKey, indexKey, slugPattern, type Brightness, type Device } from "@imageshow/shared";
import { cleanupEmptyCategories, pool, upsertCategory, withTransaction } from "../core/db.js";
import { ApiError } from "../core/http.js";
import { getRuntimeConfig } from "../config/env.js";
import { invalidateImageReadCaches, invalidateThemeVocab, rebuildFolderMap } from "../core/redis.js";
import { linkThumbnailKey, storageObjectKey, thumbnailObjectKey } from "../storage/image-paths.js";
import { copyObject, pruneEmptyStorageDirs, readStorageBuffer, removeObject, writeStorageBuffer } from "../storage/storage.js";

// Runs `task` over `items` with at most `limit` in flight (chunked), the same bounded
// storage-I/O pattern the purge path uses. Used to move a deleted theme's image files.
async function mapWithConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const size = Math.max(1, limit);
  for (let offset = 0; offset < items.length; offset += size) {
    await Promise.all(items.slice(offset, offset + size).map(task));
  }
}

// Registers a theme slug so it becomes manageable (display name + aliases). A
// no-op for the 'none' sentinel or an already-registered slug. New slugs append to
// the end of the manual order. Called within the upload / link-import / re-theme
// transactions, so it takes that transaction's client.
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
  // New themes append to the end of the manual order; re-creating an existing slug only
  // refreshes its display name (sort_order untouched).
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

// Persists the manual order: each given slug's sort_order becomes its position in the
// list. 'none' is pinned first by the read query, so it is never part of `slugs`.
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

// Moves every image off `theme` and onto the 'none' sentinel — ready images are appended (in
// order) to their device-brightness-none category to keep the index contiguous; deleted
// images are just relabelled. For stored (non-link) images the actual object + thumbnail (or,
// for a deleted image, its trash object) is moved into the none/ folder so object_key keeps
// mirroring the category, with the file copies run up to operation_log.theme_reassign_concurrency
// at a time; link images keep their external URL as the object key, but their foldered
// thumbnail is relocated to the none/ folder too. Returns whether anything moved, so callers
// can skip the (full) random-pool rebuild.
async function reassignThemeImagesToNone(theme: string): Promise<boolean> {
  // Snapshot the theme's images with everything needed to re-key + move their files.
  const images = (await pool.query(
    "SELECT id, device, brightness, ext, object_key, storage_slug, is_link, status FROM metadata WHERE theme=$1 ORDER BY device, brightness, category_index",
    [theme]
  )).rows as Array<{ id: string; device: Device; brightness: Brightness; ext: string; object_key: string; storage_slug: string; is_link: boolean; status: string }>;
  if (!images.length) return false;

  // The none-path key for each stored image (link images keep their URL). object_key mirrors
  // the category 1:1 (device-brightness/none/<id>.<ext>) and doesn't depend on the category
  // index, so it's computed — and the bytes copied — before the transaction.
  const moves = images
    .filter((image) => !image.is_link)
    .map((image) => ({ ...image, newKey: storageObjectKey(image.device, image.brightness, "none", image.id, image.ext) }))
    .filter((move) => move.newKey !== move.object_key);
  const newKeyById = new Map(moves.map((move) => [move.id, move.newKey]));
  // Link images have no stored object to re-key, but their thumbnail is foldered by theme, so it
  // must move from <device>-<brightness>/<theme>/ to .../none/ alongside the relabel.
  const linkThumbMoves = images
    .filter((image) => image.is_link)
    .map((image) => ({
      storage_slug: image.storage_slug,
      oldThumbKey: linkThumbnailKey(image.device, image.brightness, theme, image.id),
      newThumbKey: linkThumbnailKey(image.device, image.brightness, "none", image.id)
    }))
    .filter((move) => move.oldThumbKey !== move.newThumbKey);
  const concurrency = getRuntimeConfig().operation_log.theme_reassign_concurrency;

  // Phase 1: copy each stored image's bytes to the none/ key first, so both copies exist
  // across the pointer flip (the crash-safe ordering the single-image re-theme uses). A ready
  // image carries an object + thumbnail; a deleted image's only bytes are its trash object.
  await mapWithConcurrency(moves, concurrency, async (move) => {
    if (move.status === "deleted") {
      await copyObject("trash", move.object_key, "trash", move.newKey, move.storage_slug);
    } else {
      await copyObject("objects", move.object_key, "objects", move.newKey, move.storage_slug);
      await copyObject("thumbs", thumbnailObjectKey(move.object_key), "thumbs", thumbnailObjectKey(move.newKey), move.storage_slug);
    }
  });
  // Copy each link image's thumbnail to its none/ folder (small webp, copy-then-remove like above).
  await mapWithConcurrency(linkThumbMoves, concurrency, async (move) => {
    const buffer = await readStorageBuffer("link", move.oldThumbKey, move.storage_slug);
    await writeStorageBuffer("link", move.newThumbKey, buffer, "image/webp", move.storage_slug);
  });

  // Phase 2: flip the DB pointers in one transaction (category/index + object_key).
  await withTransaction(async (client) => {
    const ready = (await client.query(
      "SELECT id, device, brightness FROM metadata WHERE theme=$1 AND status='ready' ORDER BY device, brightness, category_index FOR UPDATE",
      [theme]
    )).rows as Array<{ id: string; device: Device; brightness: Brightness }>;
    const deleted = (await client.query(
      "SELECT id, device, brightness FROM metadata WHERE theme=$1 AND status='deleted' FOR UPDATE",
      [theme]
    )).rows as Array<{ id: string; device: Device; brightness: Brightness }>;
    // Ready images: append each to its device-brightness-none category in order, re-keying its
    // stored object to the none/ path (link images keep their URL via COALESCE(null)).
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
    // All ready images left the theme's own categories, so they're empty now.
    await client.query("UPDATE category SET count=0, updated_at=now() WHERE theme=$1", [theme]);
    // Deleted images: relabel theme + category_key and re-key their (trash) object.
    for (const row of deleted) {
      const target = categoryKey(row.device, row.brightness, "none");
      await upsertCategory(client, target, row.device, row.brightness, "none");
      await client.query(
        "UPDATE metadata SET theme='none', category_key=$2, object_key=COALESCE($3,object_key), updated_at=now() WHERE id=$1",
        [row.id, target, newKeyById.get(row.id) ?? null]
      );
    }
  });

  // Phase 3: drop the old-path copies, then prune the directories they vacated. Best-effort —
  // a leftover is a harmless orphan that 清理无效存储 reclaims.
  await mapWithConcurrency(moves, concurrency, async (move) => {
    if (move.status === "deleted") {
      await removeObject("trash", move.object_key, move.storage_slug).catch(() => undefined);
    } else {
      await removeObject("objects", move.object_key, move.storage_slug).catch(() => undefined);
      await removeObject("thumbs", thumbnailObjectKey(move.object_key), move.storage_slug).catch(() => undefined);
    }
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
  // 'none' is the reserved unassigned-theme sentinel that the metadata.theme foreign
  // key depends on (every unset row points at it); it is never user-deletable.
  if (slug === "none") {
    throw new ApiError(400, "invalid_theme", "The reserved 'none' theme cannot be deleted", { slug });
  }
  const exists = (await pool.query("SELECT 1 FROM theme WHERE slug=$1", [slug])).rowCount;
  if (!exists) throw new ApiError(404, "not_found", "Theme not found");
  // Reassign its images onto 'none' first so the FK no longer blocks the delete.
  const moved = await reassignThemeImagesToNone(slug);
  await pool.query("DELETE FROM theme WHERE slug = $1", [slug]);
  await invalidateThemeVocab();
  if (moved) { await cleanupEmptyCategories(); await rebuildFolderMap(); await invalidateImageReadCaches(); }
}

// Batch delete: reassign each theme's images to 'none', drop the themes, then refresh
// the random pool / caches once.
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
