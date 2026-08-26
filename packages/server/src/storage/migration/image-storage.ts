import { ApiError, errorMessage } from "../../core/api-error.ts";
import { runWithAdvisoryLockSignal } from "../../core/database/advisory-locks.ts";
import { pool } from "../../core/database/pools.ts";
import { withTransaction } from "../../core/database/transactions.ts";
import { logger } from "../../core/logger.ts";
import { md5Buffer } from "../../images/processing.ts";
import { withImageMutationSync } from "../../images/mutation-sync.ts";
import { bumpReadyImageRevision } from "../../images/ready-cache/revision.ts";
import {
  assertStorageWriteTarget,
  getStorageBackend,
  resolveStorageAccessForConfig
} from "../backends/registry.ts";
import { thumbnailObjectKey } from "../objects/image-paths.ts";
import { withImageStorageMutationLock } from "../maintenance-lock.ts";
import {
  captureMoveCleanupObjects,
  enqueueCapturedObjectsForCleanup,
  enqueueCapturedObjectsForCleanupDetached,
  type CapturedMoveCleanupObject,
  type MoveCleanupObjectInput
} from "../cleanup/service.ts";
import { contentType, type StoragePrefix } from "../objects/keys.ts";
import {
  ensureVerifiedObjectAtDestination,
  missingThumbnailSourceError
} from "../objects/transfer.ts";
import { shareStorageNamespace } from "../objects/namespace.ts";

export type StorageMigrationImageRecord = {
  id: string;
  object_key: string;
  ext: string;
  storage_slug: string;
  md5: string;
};

export type StorageMigrationResult = "migrated" | "unchanged" | "missing";

type StorageMigrationState = {
  storage_slug: string;
  object_key: string;
  status: string;
};

const storageMigrationColumns = [
  "id",
  "object_key",
  "ext",
  "storage_slug",
  "md5"
].join(", ");

async function queueCandidateCleanup(
  image: StorageMigrationImageRecord,
  target: string,
  created: readonly CapturedMoveCleanupObject[],
  reason: string,
  originalError?: unknown
) {
  try {
    await enqueueCapturedObjectsForCleanupDetached(image.id, created, reason);
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

async function readMigrationState(
  imageId: string
): Promise<StorageMigrationState | undefined> {
  return (await pool.query(
    `SELECT storage_slug, object_key, status
       FROM metadata
      WHERE id=$1`,
    [imageId]
  )).rows[0] as StorageMigrationState | undefined;
}

function hasLocation(
  state: StorageMigrationState,
  storageSlug: string,
  objectKey: string
) {
  return state.storage_slug === storageSlug && state.object_key === objectKey;
}

function migrationOutcomeUnknown(
  image: StorageMigrationImageRecord,
  target: string,
  originalError: unknown,
  details: Record<string, unknown>
) {
  const context = {
    image_id: image.id,
    source_backend: image.storage_slug,
    target_backend: target,
    object_key: image.object_key,
    original_error: errorMessage(originalError),
    ...details
  };
  logger.error("storage_migration_outcome_unknown", context);
  return new ApiError(
    503,
    "storage_migration_outcome_unknown",
    "存储迁移提交结果暂时无法确认，已保留源与目标对象供运维核对",
    context
  );
}

async function settleSwitchError(
  image: StorageMigrationImageRecord,
  target: string,
  created: readonly CapturedMoveCleanupObject[],
  sourceCleanup: readonly CapturedMoveCleanupObject[],
  originalError: unknown
): Promise<StorageMigrationState> {
  let state: StorageMigrationState | undefined;
  try {
    state = await readMigrationState(image.id);
  } catch (truthError) {
    throw migrationOutcomeUnknown(image, target, originalError, {
      truth_error: errorMessage(truthError),
      target_candidates: created,
      retained_source_objects: sourceCleanup
    });
  }

  if (state && hasLocation(state, target, image.object_key)) {
    try {
      // The transaction normally committed the deterministic cleanup receipt.
      // Re-enqueueing also covers a lost response or an out-of-protocol writer.
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
    return state;
  }

  if (state && hasLocation(state, image.storage_slug, image.object_key)) {
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
    actual_storage_slug: state?.storage_slug ?? null,
    actual_object_key: state?.object_key ?? null,
    actual_status: state?.status ?? null,
    target_candidates: created,
    retained_source_objects: sourceCleanup
  });
}

async function migrateImageStorageWhileLocked(
  requested: StorageMigrationImageRecord,
  target: string,
  expectedSource: string | undefined,
  signal: AbortSignal
): Promise<StorageMigrationResult> {
  signal.throwIfAborted();
  const current = (await pool.query(
    `SELECT ${storageMigrationColumns} FROM metadata WHERE id=$1`,
    [requested.id]
  )).rows[0] as StorageMigrationImageRecord | undefined;
  signal.throwIfAborted();
  if (!current) return "missing";
  if (expectedSource && current.storage_slug !== expectedSource) {
    return "unchanged";
  }
  if (current.storage_slug === target) return "unchanged";

  const source = await getStorageBackend(current.storage_slug);
  const destination = await assertStorageWriteTarget(target);
  signal.throwIfAborted();
  const sourceAccess = resolveStorageAccessForConfig(source);
  const destinationAccess = resolveStorageAccessForConfig(destination);
  const sharedNamespace = shareStorageNamespace(source, destination);
  const thumbKey = thumbnailObjectKey(current.object_key);
  const created: CapturedMoveCleanupObject[] = [];
  const sourceObjects: MoveCleanupObjectInput[] = [];
  let thumbnailSize = 0;

  const materialize = async (
    prefix: StoragePrefix,
    key: string,
    body: Buffer,
    objectContentType: string
  ) => {
    signal.throwIfAborted();
    const [candidate] = await captureMoveCleanupObjects([{
      prefix,
      key,
      backend: target
    }]);
    if (!candidate) {
      throw new Error("Migration candidate namespace could not be captured");
    }
    const result = await ensureVerifiedObjectAtDestination({
      source: sourceAccess,
      target: destinationAccess,
      prefix,
      key,
      body,
      contentType: objectContentType,
      cleanupCandidate: () => enqueueCapturedObjectsForCleanupDetached(
        current.id,
        [candidate],
        "storage_migration_integrity_failure"
      ),
      signal
    });
    if (result.created) created.push(candidate);
    signal.throwIfAborted();
  };

  let sourceCleanup: CapturedMoveCleanupObject[];
  try {
    if (!await sourceAccess.driver.exists(
      "media",
      current.object_key,
      { signal }
    )) {
      return "missing";
    }
    const image = await sourceAccess.driver.readBuffer(
      "media",
      current.object_key,
      { signal }
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
    if (!await sourceAccess.driver.exists("thumbs", thumbKey, { signal })) {
      throw missingThumbnailSourceError({
        imageId: current.id,
        backend: current.storage_slug,
        key: thumbKey
      });
    }
    const thumbnail = await sourceAccess.driver.readBuffer(
      "thumbs",
      thumbKey,
      { signal }
    );
    signal.throwIfAborted();
    await materialize(
      "media",
      current.object_key,
      image,
      contentType(current.ext)
    );

    thumbnailSize = thumbnail.byteLength;
    signal.throwIfAborted();
    await materialize("thumbs", thumbKey, thumbnail, "image/webp");

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

  return withImageMutationSync(async (mutationBatch) => {
    const finish = (status: string): StorageMigrationResult => {
      if (status === "ready") mutationBatch.add({ id: current.id });
      return "migrated";
    };

    let switchedStatus: string | null;
    try {
      switchedStatus = await withTransaction(async (client) => {
        signal.throwIfAborted();
        const result = await client.query(
          `UPDATE metadata
              SET storage_slug=$2,
                  thumbnail_size=$5,
                  updated_at=now()
            WHERE id=$1
              AND storage_slug=$3
              AND object_key=$4
          RETURNING status`,
          [
            current.id,
            target,
            current.storage_slug,
            current.object_key,
            thumbnailSize
          ]
        );
        const status = String(result.rows[0]?.status ?? "");
        if (!result.rowCount || !status) return null;
        await enqueueCapturedObjectsForCleanup(
          current.id,
          sourceCleanup,
          "source_cleanup_after_storage_switch",
          client
        );
        if (status === "ready") await bumpReadyImageRevision(client);
        signal.throwIfAborted();
        return status;
      });
    } catch (error) {
      const state = await settleSwitchError(
        current,
        target,
        created,
        sourceCleanup,
        error
      );
      return finish(state.status);
    }

    if (switchedStatus !== null) return finish(switchedStatus);

    // A zero-row CAS normally means another mutation won. Re-read truth before
    // deciding whether to retain the target or enqueue it for cleanup.
    let state: StorageMigrationState | undefined;
    try {
      state = await readMigrationState(current.id);
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
    if (state && hasLocation(state, target, current.object_key)) {
      await enqueueCapturedObjectsForCleanup(
        current.id,
        sourceCleanup,
        "source_cleanup_after_storage_switch"
      );
      return finish(state.status);
    }
    if (state && hasLocation(
      state,
      current.storage_slug,
      current.object_key
    )) {
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
        actual_storage_slug: state?.storage_slug ?? null,
        actual_object_key: state?.object_key ?? null,
        actual_status: state?.status ?? null,
        target_candidates: created,
        retained_source_objects: sourceCleanup
      }
    );
  });
}

export function migrateImageStorage(
  image: StorageMigrationImageRecord,
  target: string,
  options: { expectedSource?: string; signal?: AbortSignal } = {}
): Promise<StorageMigrationResult> {
  const migrate = () => withImageStorageMutationLock(image.id, (signal) =>
    migrateImageStorageWhileLocked(
      image,
      target,
      options.expectedSource,
      signal
    )
  );
  return options.signal
    ? runWithAdvisoryLockSignal(options.signal, migrate)
    : migrate();
}
