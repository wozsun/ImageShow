import { ApiError, errorMessage } from "../../core/api-error.ts";
import {
  runWithAdvisoryLockAcquisitionSignal
} from "../../core/database/advisory-locks.ts";
import { pool } from "../../core/database/pools.ts";
import { withTransaction } from "../../core/database/transactions.ts";
import { logger } from "../../core/logger.ts";
import { withImageMutationSync } from "../mutation-sync.ts";
import { bumpReadyImageRevision } from "../ready-cache/revision.ts";
import {
  assertStorageWriteTarget,
  getStorageBackend,
  resolveStorageAccessForConfig
} from "../../storage/backends/registry.ts";
import {
  imageObjectPrefix,
  thumbnailObjectKey
} from "../../storage/objects/image-paths.ts";
import { withImageStorageMutationLock } from "../../storage/maintenance-lock.ts";
import {
  captureMoveCleanupObjects,
  enqueueCapturedObjectsForCleanup,
  enqueueCapturedObjectsForCleanupWithoutLocationLock,
  type CapturedMoveCleanupObject,
  type MoveCleanupObjectInput
} from "../../storage/cleanup/service.ts";
import { contentType, type StoragePrefix } from "../../storage/objects/keys.ts";
import {
  ensureVerifiedObjectAtDestination,
  missingThumbnailSourceError
} from "../../storage/objects/transfer.ts";
import { shareStorageNamespace } from "../../storage/objects/namespace.ts";
import {
  withImageTransferAdmission
} from "../../storage/objects/image-transfer-admission.ts";

const neverAbortedStorageMigrationSignal = new AbortController().signal;

export type ImageStorageMigrationRecord = {
  id: string;
  object_key: string;
  ext: string;
  storage_slug: string;
  md5: string;
  image_size: string | number;
  thumbnail_size: string | number;
};

export type ImageStorageMigrationResult = "migrated" | "unchanged" | "missing";

type ImageStorageLocationState = {
  storage_slug: string;
  object_key: string;
  status: string;
};

const imageStorageMigrationColumns = [
  "id",
  "object_key",
  "ext",
  "storage_slug",
  "md5",
  "image_size",
  "thumbnail_size"
].join(", ");

async function enqueueMigrationCandidateCleanup(
  image: ImageStorageMigrationRecord,
  target: string,
  created: readonly CapturedMoveCleanupObject[],
  reason: string,
  originalError?: unknown
) {
  try {
    await enqueueCapturedObjectsForCleanupWithoutLocationLock(image.id, created, reason);
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

async function readImageStorageLocationState(
  imageId: string
): Promise<ImageStorageLocationState | undefined> {
  return (await pool.query(
    `SELECT storage_slug, object_key, status
       FROM metadata
      WHERE id=$1`,
    [imageId]
  )).rows[0] as ImageStorageLocationState | undefined;
}

function hasLocation(
  state: ImageStorageLocationState,
  storageSlug: string,
  objectKey: string
) {
  return state.storage_slug === storageSlug && state.object_key === objectKey;
}

function migrationOutcomeUnknown(
  image: ImageStorageMigrationRecord,
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
  image: ImageStorageMigrationRecord,
  target: string,
  created: readonly CapturedMoveCleanupObject[],
  sourceCleanup: readonly CapturedMoveCleanupObject[],
  originalError: unknown
): Promise<ImageStorageLocationState> {
  let state: ImageStorageLocationState | undefined;
  try {
    state = await readImageStorageLocationState(image.id);
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
    await enqueueMigrationCandidateCleanup(
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

async function migrateImageToStorageBackendWhileLocked(
  requested: ImageStorageMigrationRecord,
  target: string,
  expectedSource: string | undefined,
  signal: AbortSignal
): Promise<ImageStorageMigrationResult> {
  signal.throwIfAborted();
  const current = (await pool.query(
    `SELECT ${imageStorageMigrationColumns} FROM metadata WHERE id=$1`,
    [requested.id]
  )).rows[0] as ImageStorageMigrationRecord | undefined;
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
  const objectPrefix = imageObjectPrefix(current.object_key);
  const thumbKey = thumbnailObjectKey(current.object_key);
  const created: CapturedMoveCleanupObject[] = [];
  const sourceObjects: MoveCleanupObjectInput[] = [];

  const materialize = async (
    prefix: StoragePrefix,
    key: string,
    expected: { size: string | number; md5?: string },
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
      expected: {
        size: Number(expected.size),
        ...(expected.md5 ? { md5: expected.md5 } : {})
      },
      contentType: objectContentType,
      cleanupCandidate: (_object, cleanupOptions) => (
        enqueueCapturedObjectsForCleanupWithoutLocationLock(
          current.id,
          [candidate],
          "storage_migration_integrity_failure",
          cleanupOptions
        )
      ),
      signal
    });
    if (result.created) created.push(candidate);
    signal.throwIfAborted();
  };

  let sourceCleanup: CapturedMoveCleanupObject[];
  try {
    try {
      await materialize(
        objectPrefix,
        current.object_key,
        { size: current.image_size, md5: current.md5 },
        contentType(current.ext)
      );
    } catch (error) {
      if (
        error instanceof ApiError
        && error.code === "storage_source_object_not_found"
      ) {
        return "missing";
      }
      throw error;
    }
    signal.throwIfAborted();
    try {
      await materialize(
        "thumbs",
        thumbKey,
        { size: current.thumbnail_size },
        "image/webp"
      );
    } catch (error) {
      if (
        error instanceof ApiError
        && error.code === "storage_source_object_not_found"
      ) {
        throw missingThumbnailSourceError({
          imageId: current.id,
          backend: current.storage_slug,
          key: thumbKey
        });
      }
      throw error;
    }

    if (!sharedNamespace) {
      sourceObjects.push(
        {
          prefix: objectPrefix,
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
    await enqueueMigrationCandidateCleanup(
      current,
      target,
      created,
      "storage_migration_prepare_failed",
      error
    );
    throw error;
  }

  return withImageMutationSync(async (mutationBatch) => {
    const finish = (status: string): ImageStorageMigrationResult => {
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
                  updated_at=now()
            WHERE id=$1
              AND storage_slug=$3
              AND object_key=$4
          RETURNING status`,
          [
            current.id,
            target,
            current.storage_slug,
            current.object_key
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
    let state: ImageStorageLocationState | undefined;
    try {
      state = await readImageStorageLocationState(current.id);
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
      await enqueueMigrationCandidateCleanup(
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

export function migrateImageToStorageBackend(
  image: ImageStorageMigrationRecord,
  target: string,
  options: { expectedSource?: string; signal?: AbortSignal } = {}
): Promise<ImageStorageMigrationResult> {
  const migrateWithImageLock = () => withImageStorageMutationLock(
    image.id,
    (lockSignal) => {
      const operationSignal = options.signal
        ? AbortSignal.any([options.signal, lockSignal])
        : lockSignal;
      return migrateImageToStorageBackendWhileLocked(
        image,
        target,
        options.expectedSource,
        operationSignal
      );
    }
  );
  const signal = options.signal ?? neverAbortedStorageMigrationSignal;
  return withImageTransferAdmission(signal, () => (
    options.signal
      ? runWithAdvisoryLockAcquisitionSignal(
          options.signal,
          migrateWithImageLock
        )
      : migrateWithImageLock()
  ));
}
