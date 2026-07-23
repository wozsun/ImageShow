import { pool } from "../core/db.ts";
import { ApiError, errorMessage } from "../core/api-error.ts";
import { createThumbnail, md5Buffer } from "../images/processing.ts";
import { thumbnailObjectKey } from "./image-paths.ts";
import {
  assertStorageWritable,
  getStorageBackend,
  resolveStorageAccessForConfig
} from "./backend-registry.ts";
import { contentType } from "./object-keys.ts";
import { withImageStorageMutationLock } from "./maintenance-lock.ts";
import type { StoragePrefix } from "./object-keys.ts";
import { ensureVerifiedObjectAtDestination } from "./object-transfer.ts";
import { shareStorageNamespace } from "./storage-namespace.ts";
import {
  enqueueObjectsForCleanup,
  type MoveCleanupObjectInput
} from "./move-cleanup.ts";

export type MigrateRecord = {
  id: string;
  object_key: string;
  ext: string;
  status: string;
  storage_slug: string;
  device: string;
  brightness: string;
  theme: string;
  md5: string;
};

type MigrateResult = "migrated" | "unchanged" | "missing";
type CreatedObject = MoveCleanupObjectInput;

const migrateColumns = [
  "id",
  "object_key",
  "ext",
  "status",
  "storage_slug",
  "device",
  "brightness",
  "theme",
  "md5"
].join(", ");

async function removeCreatedObjects(imageId: string, objects: CreatedObject[], reason: string) {
  await enqueueObjectsForCleanup(imageId, objects, reason);
}

async function removeSourceObjects(imageId: string, objects: CreatedObject[]) {
  await enqueueObjectsForCleanup(
    imageId,
    objects,
    "source_cleanup_after_storage_switch"
  );
}

async function migrateImageStorageUnlocked(
  requested: MigrateRecord,
  target: string,
  expectedSource: string | undefined,
  signal: AbortSignal
): Promise<MigrateResult> {
  signal.throwIfAborted();
  const current = (await pool.query(
    `SELECT ${migrateColumns} FROM metadata WHERE id=$1`,
    [requested.id]
  )).rows[0] as MigrateRecord | undefined;
  signal.throwIfAborted();
  if (!current) return "missing";
  if (expectedSource && current.storage_slug !== expectedSource) return "unchanged";
  if (current.storage_slug === target) return "unchanged";

  const source = await getStorageBackend(current.storage_slug);
  const destination = await assertStorageWritable(target);
  signal.throwIfAborted();
  const sourceAccess = resolveStorageAccessForConfig(source);
  const destinationAccess = resolveStorageAccessForConfig(destination);
  const sharedNamespace = shareStorageNamespace(source, destination);
  const created: CreatedObject[] = [];
  const sourceObjects: CreatedObject[] = [];

  const materialize = async (
    prefix: StoragePrefix,
    key: string,
    body: Buffer,
    objectContentType: string,
    sourceObjectExists = true
  ) => {
    signal.throwIfAborted();
    const result = await ensureVerifiedObjectAtDestination({
      source: sourceAccess,
      target: destinationAccess,
      prefix,
      key,
      body,
      contentType: objectContentType,
      sourceObjectExists,
      cleanupCandidate: (object) => enqueueObjectsForCleanup(
        current.id,
        [object],
        "storage_migration_integrity_failure"
      )
    });
    signal.throwIfAborted();
    if (result.created) created.push({ prefix, key, backend: target });
  };

  try {
    signal.throwIfAborted();
    if (!(await sourceAccess.driver.exists("media", current.object_key))) return "missing";
    const image = await sourceAccess.driver.readBuffer("media", current.object_key);
    signal.throwIfAborted();
    if (current.md5 && md5Buffer(image) !== current.md5) {
      throw new ApiError(
        502,
        "storage_source_integrity_failed",
        "源存储对象与数据库记录的 MD5 不一致",
        { image_id: current.id, object_key: current.object_key }
      );
    }
    await materialize(
      "media",
      current.object_key,
      image,
      contentType(current.ext)
    );

    const thumbKey = thumbnailObjectKey(current.object_key);
    const sourceThumbExists = await sourceAccess.driver.exists("thumbs", thumbKey);
    const thumb = sourceThumbExists
      ? await sourceAccess.driver.readBuffer("thumbs", thumbKey)
      : await createThumbnail(image);
    signal.throwIfAborted();
    await materialize(
      "thumbs",
      thumbKey,
      thumb,
      "image/webp",
      sourceThumbExists
    );
    if (!sharedNamespace) {
      sourceObjects.push(
        { prefix: "media", key: current.object_key, backend: current.storage_slug },
        { prefix: "thumbs", key: thumbKey, backend: current.storage_slug }
      );
    }

    // The switch is conditional on the exact location that was copied. A
    // future writer that bypasses the advisory protocol still cannot make this
    // operation delete an object adopted at another location.
    signal.throwIfAborted();
    const switched = await pool.query(
      `UPDATE metadata
          SET storage_slug=$2, updated_at=now()
        WHERE id=$1 AND storage_slug=$3 AND object_key=$4`,
      [current.id, target, current.storage_slug, current.object_key]
    );
    signal.throwIfAborted();
    if (!switched.rowCount) {
      await removeCreatedObjects(
        current.id,
        created,
        "location_compare_and_swap_failed"
      ).catch(() => undefined);
      return "unchanged";
    }
  } catch (error) {
    await removeCreatedObjects(
      current.id,
      created,
      "storage_migration_failed"
    ).catch(() => undefined);
    throw error;
  }

  // Source deletion happens only after the database points at a complete
  // destination copy. Failure leaves a harmless duplicate and a retryable job.
  if (!sharedNamespace) {
    signal.throwIfAborted();
    await removeSourceObjects(current.id, sourceObjects);
    signal.throwIfAborted();
  }
  return "migrated";
}

export function migrateImageStorage(
  row: MigrateRecord,
  target: string,
  options: { expectedSource?: string } = {}
): Promise<MigrateResult> {
  return withImageStorageMutationLock(row.id, (signal) =>
    migrateImageStorageUnlocked(row, target, options.expectedSource, signal)
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
