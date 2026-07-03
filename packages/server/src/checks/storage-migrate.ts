import { pool } from "../core/db.js";
import { ApiError, errorMessage } from "../core/http.js";
import { storageObjectKey, thumbnailObjectKey } from "../storage/image-paths.js";
import { invalidateImageReadCaches, rebuildFolderMap } from "../core/redis.js";
import { migrateStorageBackend, type MigrateRecord } from "../storage/migration.js";
import { copyObject, exists, removeObject } from "../storage/storage.js";

export async function migrateStorageLocation(input: { source?: unknown; target?: unknown }) {
  const source = typeof input?.source === "string" ? input.source : "";
  const target = typeof input?.target === "string" ? input.target : "";
  if (!source || !target || source === target) throw new ApiError(400, "validation_error", "Invalid migration source/target");
  const rows = (await pool.query("SELECT id, object_key, ext, status, storage_slug, is_link, device, brightness, theme FROM metadata ORDER BY created_at ASC")).rows as MigrateRecord[];
  const migration = await migrateStorageBackend(source, target, rows);
  await invalidateImageReadCaches();
  return { migration };
}

export async function migrateStoragePaths() {
  const rows = (await pool.query("SELECT id, object_key, device, brightness, theme, ext, status, storage_slug, is_link FROM metadata ORDER BY created_at ASC")).rows as Array<{
    id: string;
    object_key: string;
    device: string;
    brightness: string;
    theme: string;
    ext: string;
    status: string;
    storage_slug: string;
    is_link: boolean;
  }>;
  let migrated = 0;
  let unchanged = 0;
  let missing = 0;
  let thumbs = 0;
  const errors: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const backend = row.storage_slug;

    if (row.is_link) {
      unchanged += 1;
      continue;
    }
    const nextKey = storageObjectKey(row.device, row.brightness, row.theme, row.id, row.ext);
    if (row.object_key === nextKey) {
      unchanged += 1;
      continue;
    }
    let copiedObject = false;
    let copiedThumb = false;
    let databaseUpdated = false;
    try {
      const oldObjectExists = await exists("objects", row.object_key, backend);
      const newObjectExists = await exists("objects", nextKey, backend);
      if (!oldObjectExists && !newObjectExists) {
        missing += 1;
        errors.push({ id: row.id, object_key: row.object_key, expected_key: nextKey, reason: "source_missing" });
        continue;
      }
      if (oldObjectExists && !newObjectExists) {
        await copyObject("objects", row.object_key, "objects", nextKey, backend);
        copiedObject = true;
      }
      const oldThumbKey = thumbnailObjectKey(row.object_key);
      const nextThumbKey = thumbnailObjectKey(nextKey);
      if (await exists("thumbs", oldThumbKey, backend)) {
        if (!(await exists("thumbs", nextThumbKey, backend))) {
          await copyObject("thumbs", oldThumbKey, "thumbs", nextThumbKey, backend);
          copiedThumb = true;
        }
        thumbs += 1;
      }
      const updated = await pool.query("UPDATE metadata SET object_key=$2, updated_at=now() WHERE id=$1 AND object_key=$3", [row.id, nextKey, row.object_key]);
      if (!updated.rowCount) throw new ApiError(409, "image_changed", "Image changed during path migration");
      databaseUpdated = true;
      if (oldObjectExists) await removeObject("objects", row.object_key, backend).catch(() => undefined);
      if (await exists("thumbs", oldThumbKey, backend)) {
        await removeObject("thumbs", oldThumbKey, backend).catch(() => undefined);
      }
      migrated += 1;
    } catch (error) {
      if (!databaseUpdated) {
        if (copiedObject) await removeObject("objects", nextKey, backend).catch(() => undefined);
        if (copiedThumb) await removeObject("thumbs", thumbnailObjectKey(nextKey), backend).catch(() => undefined);
      }
      errors.push({ id: row.id, object_key: row.object_key, expected_key: nextKey, reason: errorMessage(error) });
    }
  }
  await rebuildFolderMap();
  await invalidateImageReadCaches();
  return { migrated, unchanged, missing, thumbs, errors: errors.slice(0, 100), error_count: errors.length };
}
