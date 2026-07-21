import { pool } from "../core/db.ts";
import { errorMessage } from "../core/api-error.ts";
import { enqueue } from "../jobs/repository.ts";
import { createThumbnail } from "../images/processing.ts";
import { thumbnailObjectKey, thumbnailRef } from "./image-paths.ts";
import { assertStorageWritable, getStorageBackend } from "./backend-registry.ts";
import {
  contentType,
  readStorageBufferWithConfig,
  removeObject,
  storageExistsWithConfig,
  writeStorageBufferWithConfig
} from "./storage.ts";
import { withImageStorageMutationLock } from "./maintenance-lock.ts";
import type { StoragePrefix } from "./object-keys.ts";

export type MigrateRecord = {
  id: string;
  object_key: string;
  ext: string;
  status: string;
  storage_slug: string;
  is_link: boolean;
  device: string;
  brightness: string;
  theme: string;
};

type MigrateResult = "migrated" | "unchanged" | "missing";
type CreatedObject = { prefix: StoragePrefix; key: string; backend: string };

const migrateColumns = [
  "id",
  "object_key",
  "ext",
  "status",
  "storage_slug",
  "is_link",
  "device",
  "brightness",
  "theme"
].join(", ");

async function enqueueObjectCleanup(
  imageId: string,
  objects: CreatedObject[],
  reason: string
) {
  if (!objects.length) return;
  const cleanupKey = objects
    .map((object) => `${object.backend}:${object.prefix}:${object.key}`)
    .join("|");
  await enqueue(
    "move.cleanup",
    imageId,
    { objects, reason },
    `move.cleanup:${imageId}:${cleanupKey}`
  ).catch(() => undefined);
}

async function removeCreatedObjects(imageId: string, objects: CreatedObject[], reason: string) {
  const failed: CreatedObject[] = [];
  for (const object of objects) {
    await removeObject(object.prefix, object.key, object.backend).catch(() => {
      failed.push(object);
    });
  }
  await enqueueObjectCleanup(imageId, failed, reason);
}

async function removeSourceObjects(imageId: string, objects: CreatedObject[]) {
  const failed: CreatedObject[] = [];
  for (const object of objects) {
    await removeObject(object.prefix, object.key, object.backend).catch(() => {
      failed.push(object);
    });
  }
  await enqueueObjectCleanup(imageId, failed, "source_cleanup_after_storage_switch");
}

async function migrateImageStorageUnlocked(
  requested: MigrateRecord,
  target: string,
  expectedSource?: string
): Promise<MigrateResult> {
  const current = (await pool.query(
    `SELECT ${migrateColumns} FROM metadata WHERE id=$1`,
    [requested.id]
  )).rows[0] as MigrateRecord | undefined;
  if (!current) return "missing";
  if (expectedSource && current.storage_slug !== expectedSource) return "unchanged";
  if (current.storage_slug === target) return "unchanged";

  const source = await getStorageBackend(current.storage_slug);
  const destination = await assertStorageWritable(target);
  const created: CreatedObject[] = [];
  const sourceObjects: CreatedObject[] = [];

  try {
    if (current.is_link) {
      const thumb = thumbnailRef(current);
      if (!(await storageExistsWithConfig(source, thumb.prefix, thumb.key))) return "missing";
      if (!(await storageExistsWithConfig(destination, thumb.prefix, thumb.key))) {
        await writeStorageBufferWithConfig(
          destination,
          thumb.prefix,
          thumb.key,
          await readStorageBufferWithConfig(source, thumb.prefix, thumb.key),
          "image/webp"
        );
        created.push({ prefix: thumb.prefix, key: thumb.key, backend: target });
      }
      sourceObjects.push({ prefix: thumb.prefix, key: thumb.key, backend: current.storage_slug });
    } else {
      if (!(await storageExistsWithConfig(source, "media", current.object_key))) return "missing";
      if (!(await storageExistsWithConfig(destination, "media", current.object_key))) {
        await writeStorageBufferWithConfig(
          destination,
          "media",
          current.object_key,
          await readStorageBufferWithConfig(source, "media", current.object_key),
          contentType(current.ext)
        );
        created.push({ prefix: "media", key: current.object_key, backend: target });
      }

      const thumbKey = thumbnailObjectKey(current.object_key);
      if (!(await storageExistsWithConfig(destination, "thumbs", thumbKey))) {
        const thumb = await storageExistsWithConfig(source, "thumbs", thumbKey)
          ? await readStorageBufferWithConfig(source, "thumbs", thumbKey)
          : await createThumbnail(
              await readStorageBufferWithConfig(source, "media", current.object_key)
            );
        await writeStorageBufferWithConfig(destination, "thumbs", thumbKey, thumb, "image/webp");
        created.push({ prefix: "thumbs", key: thumbKey, backend: target });
      }
      sourceObjects.push(
        { prefix: "media", key: current.object_key, backend: current.storage_slug },
        { prefix: "thumbs", key: thumbKey, backend: current.storage_slug }
      );
    }

    // The switch is conditional on the exact location that was copied. A
    // future writer that bypasses the advisory protocol still cannot make this
    // operation delete an object adopted at another location.
    const switched = await pool.query(
      `UPDATE metadata
          SET storage_slug=$2, updated_at=now()
        WHERE id=$1 AND storage_slug=$3 AND object_key=$4`,
      [current.id, target, current.storage_slug, current.object_key]
    );
    if (!switched.rowCount) {
      await removeCreatedObjects(current.id, created, "location_compare_and_swap_failed");
      return "unchanged";
    }
  } catch (error) {
    await removeCreatedObjects(current.id, created, "storage_migration_failed");
    throw error;
  }

  // Source deletion happens only after the database points at a complete
  // destination copy. Failure leaves a harmless duplicate and a retryable job.
  await removeSourceObjects(current.id, sourceObjects);
  return "migrated";
}

export function migrateImageStorage(
  row: MigrateRecord,
  target: string,
  options: { expectedSource?: string } = {}
): Promise<MigrateResult> {
  return withImageStorageMutationLock(row.id, () =>
    migrateImageStorageUnlocked(row, target, options.expectedSource)
  );
}

export async function migrateStorageBackend(
  sourceSlug: string,
  targetSlug: string,
  entries: MigrateRecord[]
) {
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
      const result = await migrateImageStorage(entry, targetSlug, {
        expectedSource: sourceSlug
      });
      if (result === "migrated") {
        migrated += 1;
        migratedEntries.push(entry);
      } else if (result === "missing") {
        missing += 1;
        errors.push({
          id: entry.id,
          object_key: entry.object_key,
          reason: "source_object_missing"
        });
      } else {
        unchanged += 1;
      }
    } catch (error) {
      errors.push({
        id: entry.id,
        object_key: entry.object_key,
        reason: errorMessage(error)
      });
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
    error_count: errors.length
  };
}
