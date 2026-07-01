import type { Pool, PoolClient } from "pg";
import { indexKey, type Brightness } from "@imageshow/shared";
import { adjustCategoryCount, backfillCategoryHole, cleanupEmptyCategories, pool, upsertCategory, withTransaction } from "../core/db.js";
import { ApiError } from "../core/http.js";
import { getRuntimeConfig } from "../config/env.js";
import { mapWithConcurrency } from "../core/concurrency.js";
import { metadataUpdateInput, normalizedCategory, parse } from "../core/validation.js";
import { bumpFolder, invalidateImageReadCaches, invalidateMd5Cache } from "../core/redis.js";
import { enqueue } from "../jobs/tasks.js";
import { storageObjectKey, thumbnailObjectKey, thumbnailRef } from "../storage/image-paths.js";
import { copyObject, exists, readStorageBuffer, removeObject } from "../storage/storage.js";
import { migrateImageStorage, type MigrateRecord } from "../storage/migration.js";
import { isReservedSubdomain } from "../themes/host.js";
import { ensureTheme } from "../themes/service.js";
import { ensureAuthor } from "../authors/service.js";
import { detectBrightness } from "./brightness.js";
import { publicImage, type ImageRecord } from "./presenter.js";

// Resolves a "auto" brightness request to a detected light/dark by reading the image's
// stored thumbnail (a small 512px webp — cheaper to fetch and decode than the original,
// and the same artifact the upload path classified). This also lets link images be
// re-detected: their "object" is just a URL, but their thumbnail is stored locally.
// Returns undefined (leave brightness unchanged) for a non-ready row or a missing
// thumbnail (nothing settled to inspect).
async function resolveAutoBrightness(image: ImageRecord): Promise<Brightness | undefined> {
  if (image.status !== "ready") return undefined;
  const thumb = thumbnailRef({ ...image, storage_slug: image.storage_slug ?? "local", is_link: Boolean(image.is_link) });
  if (!(await exists(thumb.prefix, thumb.key, thumb.slug))) return undefined;
  return detectBrightness(await readStorageBuffer(thumb.prefix, thumb.key, thumb.slug));
}

// The shared title/description/source/original/author update for both no-category-change
// edit paths (the plain fast path on `pool`, and the in-transaction "category didn't actually
// change" path on a client). `author` is gated on `touchAuthor` so an omitted author leaves the
// column untouched while an explicit clear (authorValue=null) sets it NULL. Returns the row.
async function applyImageFieldEdits(
  executor: Pool | PoolClient,
  id: string,
  fields: { title?: string; description?: string; source?: string; original?: string },
  authorValue: string | null,
  touchAuthor: boolean
): Promise<ImageRecord> {
  const result = await executor.query(
    "UPDATE metadata SET title=COALESCE($2,title), description=COALESCE($3,description), source=COALESCE($4,source), original=COALESCE($5,original), author=CASE WHEN $7::boolean THEN $6 ELSE author END, updated_at=now() WHERE id=$1 RETURNING *",
    [id, fields.title, fields.description, fields.source, fields.original, authorValue, touchAuthor]
  );
  return result.rows[0] as ImageRecord;
}

// Soft-deletes a ready image into the recycle bin: marks it deleted, backfills the category
// index hole with the tail image, decrements the count. No storage I/O — the original and
// thumbnail stay in place (objects/ + thumbs/); they're only physically removed on purge.
export async function deleteImage(id: string) {
  // The locked row already carries md5, so return it from the transaction instead of
  // re-querying it afterwards for cache invalidation (saves one round-trip per delete).
  const deleted = await withTransaction(async (client) => {
    const image = (await client.query("SELECT * FROM metadata WHERE id=$1 AND status='ready' FOR UPDATE", [id])).rows[0];
    if (!image) throw new ApiError(404, "not_found", "Ready image not found");
    const cat = (await client.query("SELECT * FROM category WHERE category_key=$1 FOR UPDATE", [image.category_key])).rows[0];
    const count = Number(cat.count);
    await client.query("UPDATE metadata SET status='deleted', deleted_at=now(), updated_at=now() WHERE id=$1", [id]);
    await backfillCategoryHole(client, image.category_key, image.category_index, count);
    await adjustCategoryCount(client, image.category_key, -1);
    return { categoryKey: image.category_key as string, md5: (image.md5 ?? "") as string };
  });
  await bumpFolder(deleted.categoryKey, -1);
  await cleanupEmptyCategories();
  await invalidateMd5Cache(deleted.md5);
  await invalidateImageReadCaches();
}

// Updates an image's metadata. A title/description/source/original-only change is a
// simple UPDATE; changing device/brightness/theme moves the image to a new category
// (new object key, re-index of both categories) inside one transaction, with the
// new object cleaned up on rollback. Takes the raw body so not-found (404) is
// reported before body validation (400), matching the original handler order.
export async function updateImageMetadata(id: string, body: unknown) {
  const current = (await pool.query("SELECT * FROM metadata WHERE id=$1", [id])).rows[0] as ImageRecord | undefined;
  if (!current) throw new ApiError(404, "not_found", "Image not found");
  const parsed = parse(metadataUpdateInput, body);
  if (parsed.theme && isReservedSubdomain(parsed.theme)) throw new ApiError(400, "theme_reserved", "Theme conflicts with a reserved subdomain prefix", { theme: parsed.theme });
  // Resolve a "auto" brightness up front so the rest of the move logic sees a concrete
  // light/dark (or undefined = leave unchanged); the index/category bookkeeping below is
  // then identical to a normal brightness edit.
  const next = { ...parsed, brightness: parsed.brightness === "auto" ? await resolveAutoBrightness(current) : parsed.brightness };
  // Author is optional/nullable: an edit that omits it leaves it untouched, while an explicit
  // "" clears it (-> NULL). COALESCE can't express "set to NULL", so both UPDATEs gate the
  // column on `touchAuthor` and write `authorValue` (the slug, or NULL when cleared).
  const touchAuthor = next.author !== undefined;
  const authorValue = next.author ? next.author : null;
  const categoryChanged = next.device || next.brightness || next.theme;
  if (!categoryChanged) {
    // Author isn't part of category_key, so an author-only change stays on this plain-update
    // path; register a freshly-picked author first so the FK resolves.
    if (next.author) await ensureAuthor(pool, next.author);
    const updated = await applyImageFieldEdits(pool, id, next, authorValue, touchAuthor);
    await invalidateMd5Cache(current.md5 ?? "");
    await invalidateImageReadCaches();
    return publicImage(updated);
  }
  // A category move re-keys a stored object. The storage copy can be slow (an S3
  // round-trip), so it is done up front — outside the transaction and off the
  // category row locks — leaving only the index/pointer bookkeeping under lock.
  // The pre-copied object is reconciled against the authoritative locked row inside
  // the transaction; any object that the committed row doesn't adopt is cleaned up.
  const sourceIsLink = Boolean(current.is_link);
  const targetDevice = next.device ?? current.device;
  const targetBrightness = next.brightness ?? current.brightness;
  const targetTheme = next.theme ?? current.theme;
  const predictedCat = normalizedCategory({ device: targetDevice, brightness: targetBrightness, theme: targetTheme });
  // Link images keep their external URL as the object key (no bytes to copy). Skip
  // the copy for a no-op move; the transaction re-checks the category authoritatively.
  // The object key mirrors the category 1:1 (device-brightness/theme), so a real
  // category change always re-keys — but keep the key-unchanged guard as a defensive
  // no-op check, since copying an object onto itself can corrupt or drop it.
  const predictedKey = sourceIsLink ? current.object_key : storageObjectKey(targetDevice, targetBrightness, targetTheme, id, current.ext);
  let preCopiedKey = "";
  if (!sourceIsLink && current.status === "ready" && predictedCat !== current.category_key && predictedKey !== current.object_key) {
    await copyObject("objects", current.object_key, "objects", predictedKey, current.storage_slug);
    preCopiedKey = predictedKey;
  }
  // Link images have no stored object to re-key, but their thumbnail IS foldered by category
  // (<device>-<brightness>/<theme>/<id>.webp) and has no regeneration path — so a category
  // change must physically move the thumbnail file. Pre-copy it to the predicted new folder up
  // front (off the lock, like the object pre-copy): a failed copy aborts the edit before any DB
  // change, and the stale source is dropped only after the move commits. preCopiedLinkThumb is
  // reconciled against the authoritative locked category after commit, like preCopiedKey.
  let preCopiedLinkThumb = "";
  if (sourceIsLink && current.status === "ready" && predictedCat !== current.category_key) {
    const linkRow = { ...current, storage_slug: current.storage_slug ?? "local", is_link: true };
    const oldThumbKey = thumbnailRef(linkRow).key;
    const newThumbKey = thumbnailRef({ ...linkRow, device: targetDevice, brightness: targetBrightness, theme: targetTheme }).key;
    if (oldThumbKey !== newThumbKey) {
      // Backend-native copy (server-side on S3/WebDAV), same as the object pre-copy above — the
      // thumbnail bytes never round-trip through the app server.
      await copyObject("link", oldThumbKey, "link", newThumbKey, current.storage_slug);
      preCopiedLinkThumb = newThumbKey;
    }
  }

  const client = await pool.connect();
  let sourceImage = current;
  let newCat = "";
  let newKey = "";
  let copiedNewObject = false;
  let committedKey = "";
  try {
    await client.query("BEGIN");
    const locked = (await client.query("SELECT * FROM metadata WHERE id=$1 FOR UPDATE", [id])).rows[0] as ImageRecord | undefined;
    if (!locked) throw new ApiError(404, "not_found", "Image not found");
    if (locked.status !== "ready") throw new ApiError(409, "invalid_image_state", "Only ready images can change category");
    sourceImage = locked;
    const device = next.device ?? locked.device;
    const brightness = next.brightness ?? locked.brightness;
    const theme = next.theme ?? locked.theme;
    newCat = normalizedCategory({ device, brightness, theme });
    if (newCat === locked.category_key) {
      // The category didn't actually change — but the edit form always sends device/brightness/
      // theme, so a plain field edit (e.g. just setting 原图 URL) lands here too. Write the
      // title/description/source/original/author changes on the locked row before COMMIT, the
      // same field update as the no-category-change fast path.
      if (next.author) await ensureAuthor(client, next.author);
      const updated = await applyImageFieldEdits(client, id, next, authorValue, touchAuthor);
      await client.query("COMMIT");
      // No move happened, so drop anything we optimistically pre-copied.
      if (preCopiedKey) await removeObject("objects", preCopiedKey, locked.storage_slug).catch(() => undefined);
      if (preCopiedLinkThumb) await removeObject("link", preCopiedLinkThumb, locked.storage_slug).catch(() => undefined);
      await invalidateMd5Cache(locked.md5 ?? "");
      await invalidateImageReadCaches();
      return publicImage(updated);
    }
    const isLink = Boolean(locked.is_link);
    newKey = isLink ? locked.object_key : storageObjectKey(device, brightness, theme, id, locked.ext);
    for (const cat of [locked.category_key, newCat].sort()) {
      if (cat === newCat) await upsertCategory(client, cat, device, brightness, theme);
      else await upsertCategory(client, cat, locked.device, locked.brightness, locked.theme);
      await client.query("SELECT * FROM category WHERE category_key=$1 FOR UPDATE", [cat]);
    }
    // Register the (possibly new) theme and author so both are manageable.
    await ensureTheme(client, theme);
    if (next.author) await ensureAuthor(client, next.author);
    // Reconcile the pre-copy with the locked row. They match unless the row changed
    // between the initial read and acquiring the lock (rare). On a mismatch, copy the
    // correct key now; the stale pre-copy is discarded after the transaction.
    if (!isLink && newKey !== locked.object_key) {
      if (preCopiedKey !== newKey) await copyObject("objects", locked.object_key, "objects", newKey, locked.storage_slug);
      copiedNewObject = true;
    }
    const oldCount = Number((await client.query("SELECT count FROM category WHERE category_key=$1", [locked.category_key])).rows[0].count);
    const newCount = Number((await client.query("SELECT count FROM category WHERE category_key=$1", [newCat])).rows[0].count) + 1;
    // Move the locked row to its new category FIRST so it releases its old index_key
    // slot before the backfill below claims it. Doing the backfill first would briefly
    // put two ready rows on the same index_key — a unique-index violation on
    // idx_metadata_ready_index_key (which covers WHERE status='ready'). The delete path
    // sidesteps this by flipping status to 'deleted' first; a move keeps the row ready,
    // so the ordering has to do the freeing.
    await client.query(
      "UPDATE metadata SET device=$2, brightness=$3, theme=$4, category_key=$5, category_index=$6, index_key=$7, object_key=$8, title=COALESCE($9,title), description=COALESCE($10,description), source=COALESCE($11,source), original=COALESCE($12,original), author=CASE WHEN $14::boolean THEN $13 ELSE author END, updated_at=now() WHERE id=$1",
      [id, device, brightness, theme, newCat, newCount, indexKey(newCat, newCount), newKey, next.title, next.description, next.source, next.original, authorValue, touchAuthor]
    );
    // Backfill the vacated slot in the source category by pulling its last image into
    // the hole (skipped when the moved image was already the last one). The moved row
    // has left the source category, so its old index_key is now free for the filler.
    await backfillCategoryHole(client, locked.category_key, locked.category_index, oldCount);
    await adjustCategoryCount(client, locked.category_key, -1);
    await adjustCategoryCount(client, newCat, 1);
    await client.query("COMMIT");
    committedKey = newKey;
  } catch (error) {
    await client.query("ROLLBACK");
    // Remove any object we created (the in-transaction copy and/or the pre-copy)
    // that the rolled-back row never adopted, so a failed move leaves no orphan.
    const orphans = new Set<string>();
    if (copiedNewObject && newKey) orphans.add(newKey);
    if (preCopiedKey) orphans.add(preCopiedKey);
    for (const key of orphans) {
      const adopted = await client.query("SELECT 1 FROM metadata WHERE id=$1 AND object_key=$2", [id, key])
        .then((result) => Boolean(result.rowCount))
        .catch(() => false);
      if (!adopted) {
        await removeObject("objects", key, sourceImage.storage_slug).catch(() => enqueue(
          "move.cleanup",
          id,
          { object_key: key, backend: sourceImage.storage_slug },
          `move.cleanup:${id}:${key}`
        ).catch(() => undefined));
      }
    }
    // The rolled-back row never adopted the relocated link thumbnail; drop the new copy,
    // leaving the original in its old folder.
    if (preCopiedLinkThumb) await removeObject("link", preCopiedLinkThumb, sourceImage.storage_slug).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  // A reconciling re-copy (rare) leaves the original pre-copy unreferenced.
  if (preCopiedKey && preCopiedKey !== committedKey) {
    await removeObject("objects", preCopiedKey, sourceImage.storage_slug).catch(() => enqueue(
      "move.cleanup",
      id,
      { object_key: preCopiedKey, backend: sourceImage.storage_slug },
      `move.cleanup:${id}:${preCopiedKey}`
    ).catch(() => undefined));
  }
  // Only when the object actually moved to a new key: copy the thumbnail to the new key
  // (its pixels don't change on a re-key, so this is far cheaper than regenerating — no
  // original re-download or re-encode — and leaves no missing-thumbnail window), then drop
  // the stale object + old-key thumbnail. (Link thumbnails are id-keyed and relocated by the
  // pre-copy path above, so this block only runs for stored-object images.)
  if (committedKey && committedKey !== sourceImage.object_key) {
    const oldThumbKey = thumbnailObjectKey(sourceImage.object_key);
    await copyObject("thumbs", oldThumbKey, "thumbs", thumbnailObjectKey(committedKey), sourceImage.storage_slug)
      .catch(() => enqueue("thumb.generate", id).catch(() => undefined));
    await Promise.all([
      removeObject("objects", sourceImage.object_key, sourceImage.storage_slug),
      removeObject("thumbs", oldThumbKey, sourceImage.storage_slug)
    ]).catch(() => enqueue(
      "move.cleanup",
      id,
      { object_key: sourceImage.object_key, backend: sourceImage.storage_slug },
      `move.cleanup:${id}:${sourceImage.object_key}`
    ).catch(() => undefined));
  }
  await bumpFolder(sourceImage.category_key, -1);
  await bumpFolder(newCat, 1);
  await cleanupEmptyCategories();
  await invalidateMd5Cache(sourceImage.md5 ?? "");
  await invalidateImageReadCaches();
  const updated = (await pool.query("SELECT * FROM metadata WHERE id=$1", [id])).rows[0];
  // Finalize the link thumbnail relocation: the new file was pre-copied off-lock above, so now
  // just drop the old folder's copy. If a rare lock-race put the pre-copy at the wrong key, copy
  // to the authoritative new key first and discard the stale pre-copy. Best-effort removals — a
  // leftover is a harmless orphan the storage check/cleanup reaps.
  if (sourceImage.is_link && committedKey) {
    const oldThumbKey = thumbnailRef({ ...sourceImage, storage_slug: sourceImage.storage_slug ?? "local", is_link: true }).key;
    const newThumbKey = thumbnailRef({ ...updated, storage_slug: updated.storage_slug ?? "local", is_link: true }).key;
    if (oldThumbKey !== newThumbKey) {
      if (preCopiedLinkThumb !== newThumbKey) {
        await copyObject("link", oldThumbKey, "link", newThumbKey, sourceImage.storage_slug).catch(() => undefined);
        if (preCopiedLinkThumb) await removeObject("link", preCopiedLinkThumb, sourceImage.storage_slug).catch(() => undefined);
      }
      await removeObject("link", oldThumbKey, sourceImage.storage_slug).catch(() => undefined);
    }
  }
  return publicImage(updated as ImageRecord);
}

// Migrates the storage backend of one or more images (object + thumbnail together).
// Serves both the single- and multi-select admin actions — a "single" migrate is just
// this with one id. Reports per-image outcomes and refreshes the random pool for every
// category whose images actually moved.
export async function migrateImagesStorage(ids: string[], target: string) {
  const rows = (await pool.query("SELECT id, object_key, ext, status, storage_slug, is_link, device, brightness, theme, category_key FROM metadata WHERE id = ANY($1::uuid[])", [ids])).rows;
  let migrated = 0;
  let unchanged = 0;
  let failed = 0;
  const failedIds: string[] = [];
  const categories = new Set<string>();
  // Copy up to migrate_concurrency images between backends at once (each loads the full image
  // buffer), instead of strictly one-at-a-time — bounds memory / backend load while cutting the
  // wall time of a large batch. Counter/collection updates are synchronous, so no data race.
  const concurrency = getRuntimeConfig().operation_log.migrate_concurrency;
  await mapWithConcurrency(rows, concurrency, async (row) => {
    try {
      const result = await migrateImageStorage(row as MigrateRecord, target);
      if (result === "migrated") { migrated += 1; categories.add(row.category_key); }
      else if (result === "missing") { failed += 1; failedIds.push(row.id); }
      else unchanged += 1;
    } catch {
      failed += 1;
      failedIds.push(row.id);
    }
  });
  for (const category of categories) await bumpFolder(category, 0);
  if (migrated) await invalidateImageReadCaches();
  return { requested: ids.length, migrated, unchanged, failed, failed_ids: failedIds };
}
