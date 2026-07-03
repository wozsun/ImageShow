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

async function resolveAutoBrightness(image: ImageRecord): Promise<Brightness | undefined> {
  if (image.status !== "ready") return undefined;
  const thumb = thumbnailRef({ ...image, storage_slug: image.storage_slug ?? "local", is_link: Boolean(image.is_link) });
  if (!(await exists(thumb.prefix, thumb.key, thumb.slug))) return undefined;
  return detectBrightness(await readStorageBuffer(thumb.prefix, thumb.key, thumb.slug));
}

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

export async function deleteImage(id: string) {

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

export async function updateImageMetadata(id: string, body: unknown) {
  const current = (await pool.query("SELECT * FROM metadata WHERE id=$1", [id])).rows[0] as ImageRecord | undefined;
  if (!current) throw new ApiError(404, "not_found", "Image not found");
  const parsed = parse(metadataUpdateInput, body);
  if (parsed.theme && isReservedSubdomain(parsed.theme)) throw new ApiError(400, "theme_reserved", "Theme conflicts with a reserved subdomain prefix", { theme: parsed.theme });

  const next = { ...parsed, brightness: parsed.brightness === "auto" ? await resolveAutoBrightness(current) : parsed.brightness };

  const touchAuthor = next.author !== undefined;
  const authorValue = next.author ? next.author : null;
  const categoryChanged = next.device || next.brightness || next.theme;
  if (!categoryChanged) {

    if (next.author) await ensureAuthor(pool, next.author);
    const updated = await applyImageFieldEdits(pool, id, next, authorValue, touchAuthor);
    await invalidateMd5Cache(current.md5 ?? "");
    await invalidateImageReadCaches();
    return publicImage(updated);
  }

  const sourceIsLink = Boolean(current.is_link);
  const targetDevice = next.device ?? current.device;
  const targetBrightness = next.brightness ?? current.brightness;
  const targetTheme = next.theme ?? current.theme;
  const predictedCat = normalizedCategory({ device: targetDevice, brightness: targetBrightness, theme: targetTheme });

  const predictedKey = sourceIsLink ? current.object_key : storageObjectKey(targetDevice, targetBrightness, targetTheme, id, current.ext);
  let preCopiedKey = "";
  if (!sourceIsLink && current.status === "ready" && predictedCat !== current.category_key && predictedKey !== current.object_key) {
    await copyObject("objects", current.object_key, "objects", predictedKey, current.storage_slug);
    preCopiedKey = predictedKey;
  }

  let preCopiedLinkThumb = "";
  if (sourceIsLink && current.status === "ready" && predictedCat !== current.category_key) {
    const linkRow = { ...current, storage_slug: current.storage_slug ?? "local", is_link: true };
    const oldThumbKey = thumbnailRef(linkRow).key;
    const newThumbKey = thumbnailRef({ ...linkRow, device: targetDevice, brightness: targetBrightness, theme: targetTheme }).key;
    if (oldThumbKey !== newThumbKey) {

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

      if (next.author) await ensureAuthor(client, next.author);
      const updated = await applyImageFieldEdits(client, id, next, authorValue, touchAuthor);
      await client.query("COMMIT");

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

    await ensureTheme(client, theme);
    if (next.author) await ensureAuthor(client, next.author);

    if (!isLink && newKey !== locked.object_key) {
      if (preCopiedKey !== newKey) await copyObject("objects", locked.object_key, "objects", newKey, locked.storage_slug);
      copiedNewObject = true;
    }
    const oldCount = Number((await client.query("SELECT count FROM category WHERE category_key=$1", [locked.category_key])).rows[0].count);
    const newCount = Number((await client.query("SELECT count FROM category WHERE category_key=$1", [newCat])).rows[0].count) + 1;

    await client.query(
      "UPDATE metadata SET device=$2, brightness=$3, theme=$4, category_key=$5, category_index=$6, index_key=$7, object_key=$8, title=COALESCE($9,title), description=COALESCE($10,description), source=COALESCE($11,source), original=COALESCE($12,original), author=CASE WHEN $14::boolean THEN $13 ELSE author END, updated_at=now() WHERE id=$1",
      [id, device, brightness, theme, newCat, newCount, indexKey(newCat, newCount), newKey, next.title, next.description, next.source, next.original, authorValue, touchAuthor]
    );

    await backfillCategoryHole(client, locked.category_key, locked.category_index, oldCount);
    await adjustCategoryCount(client, locked.category_key, -1);
    await adjustCategoryCount(client, newCat, 1);
    await client.query("COMMIT");
    committedKey = newKey;
  } catch (error) {
    await client.query("ROLLBACK");

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

    if (preCopiedLinkThumb) await removeObject("link", preCopiedLinkThumb, sourceImage.storage_slug).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  if (preCopiedKey && preCopiedKey !== committedKey) {
    await removeObject("objects", preCopiedKey, sourceImage.storage_slug).catch(() => enqueue(
      "move.cleanup",
      id,
      { object_key: preCopiedKey, backend: sourceImage.storage_slug },
      `move.cleanup:${id}:${preCopiedKey}`
    ).catch(() => undefined));
  }

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

export async function migrateImagesStorage(ids: string[], target: string) {
  const rows = (await pool.query("SELECT id, object_key, ext, status, storage_slug, is_link, device, brightness, theme, category_key FROM metadata WHERE id = ANY($1::uuid[])", [ids])).rows;
  let migrated = 0;
  let unchanged = 0;
  let failed = 0;
  const failedIds: string[] = [];
  const categories = new Set<string>();

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
