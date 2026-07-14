import { pool } from "../core/db.ts";
import { errorMessage } from "../core/http.ts";
import { thumbnailObjectKey, thumbnailRef } from "./image-paths.ts";
import { assertStorageWritable, getStorageBackend } from "./backend-registry.ts";
import { createThumbnail } from "../images/processing.ts";
import {
  contentType,
  readStorageBufferWithConfig,
  removeObject,
  storageExistsWithConfig,
  writeStorageBufferWithConfig
} from "./storage.ts";
import { withStorageMutationLock } from "./maintenance-lock.ts";

export type MigrateRecord = { id: string; object_key: string; ext: string; status: string; storage_slug: string; is_link: boolean; device: string; brightness: string; theme: string };
type MigrateResult = "migrated" | "unchanged" | "missing";

async function migrateImageStorageUnlocked(row: MigrateRecord, target: string): Promise<MigrateResult> {
  if (row.storage_slug === target) return "unchanged";
  const source = await getStorageBackend(row.storage_slug);
  const dest = await assertStorageWritable(target);

  if (row.is_link) {
    const thumb = thumbnailRef(row);
    if (!(await storageExistsWithConfig(source, thumb.prefix, thumb.key))) return "missing";
    if (!(await storageExistsWithConfig(dest, thumb.prefix, thumb.key))) {
      await writeStorageBufferWithConfig(dest, thumb.prefix, thumb.key, await readStorageBufferWithConfig(source, thumb.prefix, thumb.key), "image/webp");
    }
    const moved = await pool.query(
      "UPDATE metadata SET storage_slug=$2, updated_at=now() WHERE id=$1 AND storage_slug=$3",
      [row.id, target, row.storage_slug]
    );
    if (!moved.rowCount) return "unchanged";
    await removeObject(thumb.prefix, thumb.key, row.storage_slug).catch(() => undefined);
    return "migrated";
  }

  if (!(await storageExistsWithConfig(source, "media", row.object_key))) return "missing";
  if (!(await storageExistsWithConfig(dest, "media", row.object_key))) {
    await writeStorageBufferWithConfig(
      dest,
      "media",
      row.object_key,
      await readStorageBufferWithConfig(source, "media", row.object_key),
      contentType(row.ext)
    );
  }
  const thumbKey = thumbnailObjectKey(row.object_key);
  if (!(await storageExistsWithConfig(dest, "thumbs", thumbKey))) {
    const thumb = await storageExistsWithConfig(source, "thumbs", thumbKey)
      ? await readStorageBufferWithConfig(source, "thumbs", thumbKey)
      : await createThumbnail(await readStorageBufferWithConfig(source, "media", row.object_key));
    await writeStorageBufferWithConfig(dest, "thumbs", thumbKey, thumb, "image/webp");
  }
  const updated = await pool.query(
    "UPDATE metadata SET storage_slug=$2, updated_at=now() WHERE id=$1 AND storage_slug=$3",
    [row.id, target, row.storage_slug]
  );
  if (!updated.rowCount) return "unchanged";
  await removeObject("media", row.object_key, row.storage_slug).catch(() => undefined);
  await removeObject("thumbs", thumbKey, row.storage_slug).catch(() => undefined);
  return "migrated";
}

export function migrateImageStorage(row: MigrateRecord, target: string): Promise<MigrateResult> {
  return withStorageMutationLock(() => migrateImageStorageUnlocked(row, target));
}

export async function migrateStorageBackend(sourceSlug: string, targetSlug: string, entries: MigrateRecord[]) {
  let migrated = 0;
  let unchanged = 0;
  let missing = 0;
  const migratedEntries: MigrateRecord[] = [];
  const errors: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    if (entry.storage_slug !== sourceSlug) {
      unchanged += 1;
      continue;
    }
    try {
      const result = await migrateImageStorage(entry, targetSlug);
      if (result === "migrated") {
        migrated += 1;
        migratedEntries.push(entry);
      }
      else if (result === "missing") {
        missing += 1;
        errors.push({ id: entry.id, object_key: entry.object_key, reason: "source_object_missing" });
      } else {
        unchanged += 1;
      }
    } catch (error) {
      errors.push({ id: entry.id, object_key: entry.object_key, reason: errorMessage(error) });
    }
  }
  return {
    source: sourceSlug,
    target: targetSlug,
    migrated,
    migratedEntries,
    unchanged,
    missing,
    errors: errors.slice(0, 100),
    error_count: errors.length,
  };
}
