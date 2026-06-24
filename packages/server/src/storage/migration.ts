import { contentType, createThumbnail } from "../images/processing.js";
import { thumbnailObjectKey } from "./image-paths.js";
import { pool } from "../core/db.js";
import { getStorageConfig, type StorageBackend } from "../config/settings.js";
import {
  readStorageBufferWithConfig,
  removeObject,
  storageConfigForBackend,
  storageConfigForBackendUnchecked,
  storageExistsWithConfig,
  writeStorageBufferWithConfig
} from "./storage.js";

export type MigrateRow = { id: string; object_key: string; ext: string; status: string; storage_backend: StorageBackend };
type MigrateResult = "migrated" | "unchanged" | "missing";

// Moves one image's object (and thumbnail) from its current backend to `target`,
// flips metadata.storage_backend, then best-effort deletes the source copy. The
// DB flip is optimistic (guarded on the old backend) so concurrent migrations
// don't double-apply; leftover source objects are caught by storage cleanup.
export async function migrateImageStorage(row: MigrateRow, target: StorageBackend): Promise<MigrateResult> {
  if (row.storage_backend === target) return "unchanged";
  const config = await getStorageConfig();
  const source = storageConfigForBackendUnchecked(config, row.storage_backend);
  const dest = storageConfigForBackend(config, target); // validates target S3 credentials
  const objectPrefix = row.status === "deleted" ? "trash" : "objects";
  if (!(await storageExistsWithConfig(source, objectPrefix, row.object_key))) return "missing";
  if (!(await storageExistsWithConfig(dest, objectPrefix, row.object_key))) {
    await writeStorageBufferWithConfig(
      dest,
      objectPrefix,
      row.object_key,
      await readStorageBufferWithConfig(source, objectPrefix, row.object_key),
      contentType(row.ext)
    );
  }
  const thumbKey = thumbnailObjectKey(row.object_key);
  if (row.status === "ready" && !(await storageExistsWithConfig(dest, "thumbs", thumbKey))) {
    const thumb = await storageExistsWithConfig(source, "thumbs", thumbKey)
      ? await readStorageBufferWithConfig(source, "thumbs", thumbKey)
      : await createThumbnail(await readStorageBufferWithConfig(source, "objects", row.object_key));
    await writeStorageBufferWithConfig(dest, "thumbs", thumbKey, thumb, "image/webp");
  }
  const updated = await pool.query(
    "UPDATE metadata SET storage_backend=$2, updated_at=now() WHERE id=$1 AND storage_backend=$3",
    [row.id, target, row.storage_backend]
  );
  if (!updated.rowCount) return "unchanged";
  await removeObject(objectPrefix, row.object_key, row.storage_backend).catch(() => undefined);
  if (row.status === "ready") await removeObject("thumbs", thumbKey, row.storage_backend).catch(() => undefined);
  return "migrated";
}

// Migrates every image currently on the source backend to the other backend and
// updates each row's storage_backend (the check page's "migrate storage backend").
export async function migrateStorageBackend(direction: "local-to-s3" | "s3-to-local", entries: MigrateRow[]) {
  const sourceBackend: StorageBackend = direction === "local-to-s3" ? "local" : "s3";
  const targetBackend: StorageBackend = direction === "local-to-s3" ? "s3" : "local";
  let migrated = 0;
  let unchanged = 0;
  let missing = 0;
  const errors: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    if (entry.storage_backend !== sourceBackend) {
      unchanged += 1;
      continue;
    }
    try {
      const result = await migrateImageStorage(entry, targetBackend);
      if (result === "migrated") migrated += 1;
      else if (result === "missing") {
        missing += 1;
        errors.push({ id: entry.id, object_key: entry.object_key, reason: "source_object_missing" });
      } else {
        unchanged += 1;
      }
    } catch (error) {
      errors.push({ id: entry.id, object_key: entry.object_key, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { direction, migrated, unchanged, missing, errors: errors.slice(0, 100), error_count: errors.length };
}
