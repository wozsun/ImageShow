import type { Pool, PoolClient } from "pg";
import type { Brightness } from "@imageshow/shared";
import { pool, withTransaction } from "../core/db.js";
import { ApiError } from "../core/http.js";
import { getRuntimeConfig } from "../config/env.js";
import { mapWithConcurrency } from "../core/concurrency.js";
import { metadataUpdateInput, parse } from "../core/validation.js";
import { invalidateImageReadCaches, invalidateMd5Cache } from "./image-cache.js";
import { syncRandomImage, syncRandomImages } from "../random/random-cache.js";
import { enqueue } from "../jobs/tasks.js";
import { storageObjectKey, thumbnailObjectKey, thumbnailRef } from "../storage/image-paths.js";
import { copyObject, exists, readStorageBuffer, removeObject } from "../storage/storage.js";
import { migrateImageStorage, type MigrateRecord } from "../storage/migration.js";
import { isReservedSubdomain } from "../themes/host.js";
import { ensureTheme } from "../themes/service.js";
import { ensureAuthor } from "../authors/service.js";
import { detectBrightness } from "./brightness.js";
import { publicImage, type ImageRecord } from "./presenter.js";

function storageSlug(image: Pick<ImageRecord, "storage_slug">) {
  return image.storage_slug ?? "local";
}

async function resolveAutoBrightness(image: ImageRecord): Promise<Brightness | undefined> {
  if (image.status !== "ready") return undefined;
  const thumb = thumbnailRef({ ...image, storage_slug: storageSlug(image), is_link: Boolean(image.is_link) });
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
    const result = await client.query(
      "UPDATE metadata SET status='deleted', deleted_at=now(), updated_at=now() WHERE id=$1 AND status='ready' RETURNING id, md5",
      [id]
    );
    if (!result.rowCount) throw new ApiError(404, "not_found", "Ready image not found");
    return result.rows[0] as { id: string; md5: string | null };
  });
  await syncRandomImage(deleted.id);
  await invalidateMd5Cache(deleted.md5 ?? "");
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
  const targetDevice = next.device ?? current.device;
  const targetBrightness = next.brightness ?? current.brightness;
  const targetTheme = next.theme ?? current.theme;
  const classificationChanged = targetDevice !== current.device || targetBrightness !== current.brightness || targetTheme !== current.theme;

  if (!classificationChanged) {
    if (next.author) await ensureAuthor(pool, next.author);
    const updated = await applyImageFieldEdits(pool, id, next, authorValue, touchAuthor);
    await syncRandomImage(id);
    await invalidateMd5Cache(current.md5 ?? "");
    await invalidateImageReadCaches();
    return publicImage(updated);
  }

  if (current.status !== "ready") throw new ApiError(409, "invalid_image_state", "Only ready images can change category");
  const sourceIsLink = Boolean(current.is_link);
  const sourceSlug = storageSlug(current);
  const predictedKey = sourceIsLink ? current.object_key : storageObjectKey(targetDevice, targetBrightness, targetTheme, id, current.ext);
  let preCopiedObjectKey = "";
  let preCopiedLinkThumbKey = "";

  if (!sourceIsLink && predictedKey !== current.object_key) {
    await copyObject("media", current.object_key, "media", predictedKey, sourceSlug);
    preCopiedObjectKey = predictedKey;
  }

  if (sourceIsLink) {
    const oldThumb = thumbnailRef({ ...current, storage_slug: sourceSlug, is_link: true });
    const newThumb = thumbnailRef({ ...current, device: targetDevice, brightness: targetBrightness, theme: targetTheme, storage_slug: sourceSlug, is_link: true });
    if (oldThumb.key !== newThumb.key) {
      await copyObject("link", oldThumb.key, "link", newThumb.key, sourceSlug);
      preCopiedLinkThumbKey = newThumb.key;
    }
  }

  const client = await pool.connect();
  let sourceImage = current;
  let updated: ImageRecord | null = null;
  let committedObjectKey = "";
  let copiedObjectKey = "";
  try {
    await client.query("BEGIN");
    const locked = (await client.query("SELECT * FROM metadata WHERE id=$1 FOR UPDATE", [id])).rows[0] as ImageRecord | undefined;
    if (!locked) throw new ApiError(404, "not_found", "Image not found");
    if (locked.status !== "ready") throw new ApiError(409, "invalid_image_state", "Only ready images can change category");
    sourceImage = locked;

    const device = next.device ?? locked.device;
    const brightness = next.brightness ?? locked.brightness;
    const theme = next.theme ?? locked.theme;
    const isLink = Boolean(locked.is_link);
    const nextObjectKey = isLink ? locked.object_key : storageObjectKey(device, brightness, theme, id, locked.ext);

    if (device === locked.device && brightness === locked.brightness && theme === locked.theme) {
      if (next.author) await ensureAuthor(client, next.author);
      updated = await applyImageFieldEdits(client, id, next, authorValue, touchAuthor);
      await client.query("COMMIT");
      committedObjectKey = locked.object_key;
    } else {
      await ensureTheme(client, theme);
      if (next.author) await ensureAuthor(client, next.author);

      if (!isLink && nextObjectKey !== locked.object_key) {
        if (preCopiedObjectKey !== nextObjectKey) {
          await copyObject("media", locked.object_key, "media", nextObjectKey, storageSlug(locked));
          copiedObjectKey = nextObjectKey;
        }
      }

      const result = await client.query(
        "UPDATE metadata SET device=$2, brightness=$3, theme=$4, object_key=$5, title=COALESCE($6,title), description=COALESCE($7,description), source=COALESCE($8,source), original=COALESCE($9,original), author=CASE WHEN $11::boolean THEN $10 ELSE author END, updated_at=now() WHERE id=$1 RETURNING *",
        [id, device, brightness, theme, nextObjectKey, next.title, next.description, next.source, next.original, authorValue, touchAuthor]
      );
      updated = result.rows[0] as ImageRecord;
      await client.query("COMMIT");
      committedObjectKey = nextObjectKey;
    }
  } catch (error) {
    await client.query("ROLLBACK");
    const orphanKeys = new Set<string>();
    if (preCopiedObjectKey) orphanKeys.add(preCopiedObjectKey);
    if (copiedObjectKey) orphanKeys.add(copiedObjectKey);
    for (const key of orphanKeys) {
      const adopted = await pool.query("SELECT 1 FROM metadata WHERE id=$1 AND object_key=$2", [id, key])
        .then((result) => Boolean(result.rowCount))
        .catch(() => false);
      if (!adopted) {
        await removeObject("media", key, storageSlug(sourceImage)).catch(() => enqueue(
          "move.cleanup",
          id,
          { object_key: key, backend: storageSlug(sourceImage) },
          `move.cleanup:${id}:${key}`
        ).catch(() => undefined));
      }
    }
    if (preCopiedLinkThumbKey) await removeObject("link", preCopiedLinkThumbKey, storageSlug(sourceImage)).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  if (preCopiedObjectKey && preCopiedObjectKey !== committedObjectKey) {
    await removeObject("media", preCopiedObjectKey, storageSlug(sourceImage)).catch(() => enqueue(
      "move.cleanup",
      id,
      { object_key: preCopiedObjectKey, backend: storageSlug(sourceImage) },
      `move.cleanup:${id}:${preCopiedObjectKey}`
    ).catch(() => undefined));
  }

  if (committedObjectKey && committedObjectKey !== sourceImage.object_key) {
    const oldThumbKey = thumbnailObjectKey(sourceImage.object_key);
    await copyObject("thumbs", oldThumbKey, "thumbs", thumbnailObjectKey(committedObjectKey), storageSlug(sourceImage))
      .catch(() => enqueue("thumb.generate", id).catch(() => undefined));
    await Promise.all([
      removeObject("media", sourceImage.object_key, storageSlug(sourceImage)),
      removeObject("thumbs", oldThumbKey, storageSlug(sourceImage))
    ]).catch(() => enqueue(
      "move.cleanup",
      id,
      { object_key: sourceImage.object_key, backend: storageSlug(sourceImage) },
      `move.cleanup:${id}:${sourceImage.object_key}`
    ).catch(() => undefined));
  }

  if (sourceImage.is_link && updated) {
    const oldThumbKey = thumbnailRef({ ...sourceImage, storage_slug: storageSlug(sourceImage), is_link: true }).key;
    const newThumbKey = thumbnailRef({ ...updated, storage_slug: storageSlug(updated), is_link: true }).key;
    if (oldThumbKey !== newThumbKey) {
      if (preCopiedLinkThumbKey !== newThumbKey) {
        await copyObject("link", oldThumbKey, "link", newThumbKey, storageSlug(sourceImage)).catch(() => undefined);
        if (preCopiedLinkThumbKey) await removeObject("link", preCopiedLinkThumbKey, storageSlug(sourceImage)).catch(() => undefined);
      }
      await removeObject("link", oldThumbKey, storageSlug(sourceImage)).catch(() => undefined);
    }
  }

  await syncRandomImage(id);
  await invalidateMd5Cache(sourceImage.md5 ?? "");
  await invalidateImageReadCaches();
  return publicImage(updated ?? (await pool.query("SELECT * FROM metadata WHERE id=$1", [id])).rows[0] as ImageRecord);
}

export async function migrateImagesStorage(ids: string[], target: string) {
  const rows = (await pool.query("SELECT id, object_key, ext, status, storage_slug, is_link, device, brightness, theme FROM metadata WHERE id = ANY($1::uuid[])", [ids])).rows;
  let migrated = 0;
  let unchanged = 0;
  let failed = 0;
  const failedIds: string[] = [];
  const migratedIds: string[] = [];

  const concurrency = getRuntimeConfig().background_job.migrate_concurrency;
  await mapWithConcurrency(rows, concurrency, async (row) => {
    try {
      const result = await migrateImageStorage(row as MigrateRecord, target);
      if (result === "migrated") {
        migrated += 1;
        migratedIds.push(row.id);
      } else if (result === "missing") {
        failed += 1;
        failedIds.push(row.id);
      } else {
        unchanged += 1;
      }
    } catch {
      failed += 1;
      failedIds.push(row.id);
    }
  });
  if (migratedIds.length) {
    await syncRandomImages(migratedIds);
    await invalidateImageReadCaches();
  }
  return { requested: ids.length, migrated, unchanged, failed, failed_ids: failedIds };
}
