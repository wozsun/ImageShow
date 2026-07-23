import { ApiError, errorMessage } from "../core/api-error.ts";
import { pool, withTransaction } from "../core/db.ts";
import { logger } from "../core/logger.ts";
import { createThumbnail, md5Buffer } from "../images/processing.ts";
import {
  assertStorageWritable,
  getStorageBackend,
  resolveStorageAccessForConfig
} from "./backend-registry.ts";
import { thumbnailObjectKey } from "./image-paths.ts";
import { withImageStorageMutationLock } from "./maintenance-lock.ts";
import {
  captureMoveCleanupObjects,
  enqueueCapturedObjectsForCleanup,
  enqueueObjectsForCleanup,
  type CapturedMoveCleanupObject,
  type MoveCleanupObjectInput
} from "./move-cleanup.ts";
import { contentType, type StoragePrefix } from "./object-keys.ts";
import { ensureVerifiedObjectAtDestination } from "./object-transfer.ts";
import { shareStorageNamespace } from "./storage-namespace.ts";

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
type MigrationLocation = Pick<MigrateRecord, "storage_slug" | "object_key">;

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

async function queueCandidateCleanup(
  image: MigrateRecord,
  target: string,
  created: readonly MoveCleanupObjectInput[],
  reason: string,
  originalError?: unknown
) {
  try {
    await enqueueObjectsForCleanup(image.id, created, reason);
  } catch (cleanupError) {
    logger.error("storage_migration_candidate_enqueue_failed", {
      image_id: image.id,
      source_backend: image.storage_slug,
      target_backend: target,
      object_key: image.object_key,
      cleanup_reason: reason,
      ...(originalError
        ? { original_error: errorMessage(originalError) }
        : {}),
      cleanup_error: errorMessage(cleanupError),
      candidates: created
    });
    if (originalError) {
      throw new AggregateError(
        [originalError, cleanupError],
        "Storage migration failed and candidate cleanup could not be queued"
      );
    }
    throw cleanupError;
  }
}

async function readMigrationLocation(
  imageId: string
): Promise<MigrationLocation | undefined> {
  return (await pool.query(
    `SELECT storage_slug, object_key
       FROM metadata
      WHERE id=$1`,
    [imageId]
  )).rows[0] as MigrationLocation | undefined;
}

function isLocation(
  location: MigrationLocation | undefined,
  storageSlug: string,
  objectKey: string
) {
  return location?.storage_slug === storageSlug
    && location.object_key === objectKey;
}

function migrationOutcomeUnknown(
  image: MigrateRecord,
  target: string,
  originalError: unknown,
  details: Record<string, unknown>
) {
  logger.error("storage_migration_outcome_unknown", {
    image_id: image.id,
    source_backend: image.storage_slug,
    target_backend: target,
    object_key: image.object_key,
    original_error: errorMessage(originalError),
    ...details
  });
  return new ApiError(
    503,
    "storage_migration_outcome_unknown",
    "存储迁移提交结果暂时无法确认，已保留源与目标对象供运维核对",
    {
      image_id: image.id,
      source_backend: image.storage_slug,
      target_backend: target,
      object_key: image.object_key,
      original_error: errorMessage(originalError),
      ...details
    }
  );
}

async function settleMigrationSwitchError(
  image: MigrateRecord,
  target: string,
  created: readonly MoveCleanupObjectInput[],
  sourceCleanup: readonly CapturedMoveCleanupObject[],
  originalError: unknown
): Promise<MigrateResult> {
  let location: MigrationLocation | undefined;
  try {
    location = await readMigrationLocation(image.id);
  } catch (truthError) {
    throw migrationOutcomeUnknown(image, target, originalError, {
      truth_error: errorMessage(truthError),
      target_candidates: created,
      retained_source_objects: sourceCleanup
    });
  }

  if (isLocation(location, target, image.object_key)) {
    // The metadata and cleanup receipt normally committed atomically. Enqueue
    // again to also cover a writer that bypassed this transaction; the
    // deterministic key makes the operation idempotent.
    try {
      await enqueueCapturedObjectsForCleanup(
        image.id,
        sourceCleanup,
        "source_cleanup_after_storage_switch"
      );
    } catch (cleanupError) {
      logger.error("storage_migration_source_cleanup_enqueue_failed", {
        image_id: image.id,
        source_backend: image.storage_slug,
        target_backend: target,
        object_key: image.object_key,
        original_error: errorMessage(originalError),
        cleanup_error: errorMessage(cleanupError),
        retained_source_objects: sourceCleanup
      });
      throw new ApiError(
        503,
        "storage_migration_cleanup_unavailable",
        "图片已指向目标存储，但旧对象清理任务暂时无法确认",
        {
          image_id: image.id,
          source_backend: image.storage_slug,
          target_backend: target,
          object_key: image.object_key
        }
      );
    }
    logger.warn("storage_migration_destination_adopted_after_error", {
      image_id: image.id,
      source_backend: image.storage_slug,
      target_backend: target,
      object_key: image.object_key,
      original_error: errorMessage(originalError)
    });
    return "migrated";
  }

  if (isLocation(location, image.storage_slug, image.object_key)) {
    await queueCandidateCleanup(
      image,
      target,
      created,
      "storage_migration_rolled_back",
      originalError
    );
    throw originalError;
  }

  throw migrationOutcomeUnknown(image, target, originalError, {
    actual_storage_slug: location?.storage_slug ?? null,
    actual_object_key: location?.object_key ?? null,
    target_candidates: created,
    retained_source_objects: sourceCleanup
  });
}

async function migrateImageStorageWhileLocked(
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
  if (expectedSource && current.storage_slug !== expectedSource) {
    return "unchanged";
  }
  if (current.storage_slug === target) return "unchanged";

  const source = await getStorageBackend(current.storage_slug);
  const destination = await assertStorageWritable(target);
  signal.throwIfAborted();
  const sourceAccess = resolveStorageAccessForConfig(source);
  const destinationAccess = resolveStorageAccessForConfig(destination);
  const sharedNamespace = shareStorageNamespace(source, destination);
  const created: MoveCleanupObjectInput[] = [];
  const sourceObjects: MoveCleanupObjectInput[] = [];

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
    if (result.created) {
      created.push({ prefix, key, backend: target });
    }
  };

  let sourceCleanup: CapturedMoveCleanupObject[];
  try {
    if (!await sourceAccess.driver.exists("media", current.object_key)) {
      return "missing";
    }
    const image = await sourceAccess.driver.readBuffer(
      "media",
      current.object_key
    );
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
    const sourceThumbExists = await sourceAccess.driver.exists(
      "thumbs",
      thumbKey
    );
    const thumbnail = sourceThumbExists
      ? await sourceAccess.driver.readBuffer("thumbs", thumbKey)
      : await createThumbnail(image);
    signal.throwIfAborted();
    await materialize(
      "thumbs",
      thumbKey,
      thumbnail,
      "image/webp",
      sourceThumbExists
    );
    if (!sharedNamespace) {
      sourceObjects.push(
        {
          prefix: "media",
          key: current.object_key,
          backend: current.storage_slug
        },
        {
          prefix: "thumbs",
          key: thumbKey,
          backend: current.storage_slug
        }
      );
    }
    sourceCleanup = await captureMoveCleanupObjects(sourceObjects);
    signal.throwIfAborted();
  } catch (error) {
    await queueCandidateCleanup(
      current,
      target,
      created,
      "storage_migration_prepare_failed",
      error
    );
    throw error;
  }

  let switched: boolean;
  try {
    switched = await withTransaction(async (client) => {
      signal.throwIfAborted();
      const result = await client.query(
        `UPDATE metadata
            SET storage_slug=$2, updated_at=now()
          WHERE id=$1
            AND storage_slug=$3
            AND object_key=$4`,
        [current.id, target, current.storage_slug, current.object_key]
      );
      if (!result.rowCount) return false;
      await enqueueCapturedObjectsForCleanup(
        current.id,
        sourceCleanup,
        "source_cleanup_after_storage_switch",
        client
      );
      signal.throwIfAborted();
      return true;
    });
  } catch (error) {
    return settleMigrationSwitchError(
      current,
      target,
      created,
      sourceCleanup,
      error
    );
  }

  if (switched) return "migrated";

  // A zero-row CAS should mean the source is unchanged, but re-read before
  // compensating so an out-of-protocol writer cannot make a target candidate
  // authoritative between the CAS and cleanup decision.
  let location: MigrationLocation | undefined;
  try {
    location = await readMigrationLocation(current.id);
  } catch (truthError) {
    throw migrationOutcomeUnknown(
      current,
      target,
      new Error("storage migration compare-and-swap affected no rows"),
      {
        truth_error: errorMessage(truthError),
        target_candidates: created,
        retained_source_objects: sourceCleanup
      }
    );
  }
  if (isLocation(location, target, current.object_key)) {
    await enqueueCapturedObjectsForCleanup(
      current.id,
      sourceCleanup,
      "source_cleanup_after_storage_switch"
    );
    return "migrated";
  }
  if (isLocation(location, current.storage_slug, current.object_key)) {
    await queueCandidateCleanup(
      current,
      target,
      created,
      "location_compare_and_swap_failed"
    );
    return "unchanged";
  }
  throw migrationOutcomeUnknown(
    current,
    target,
    new Error("storage migration compare-and-swap affected no rows"),
    {
      actual_storage_slug: location?.storage_slug ?? null,
      actual_object_key: location?.object_key ?? null,
      target_candidates: created,
      retained_source_objects: sourceCleanup
    }
  );
}

export function migrateImageStorage(
  row: MigrateRecord,
  target: string,
  options: { expectedSource?: string } = {}
): Promise<MigrateResult> {
  return withImageStorageMutationLock(row.id, (signal) =>
    migrateImageStorageWhileLocked(
      row,
      target,
      options.expectedSource,
      signal
    )
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
