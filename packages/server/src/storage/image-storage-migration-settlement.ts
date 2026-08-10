import { ApiError, errorMessage } from "../core/api-error.ts";
import { pool } from "../core/database-pools.ts";
import { logger } from "../core/logger.ts";
import {
  enqueueCapturedObjectsForCleanup,
  enqueueCapturedObjectsForCleanupDetached,
  type CapturedMoveCleanupObject
} from "./move-cleanup.ts";
import type {
  StorageMigrationImageRecord,
  StorageMigrationState
} from "./image-storage-migration-contract.ts";

export async function queueStorageMigrationCandidateCleanup(
  image: StorageMigrationImageRecord,
  target: string,
  created: readonly CapturedMoveCleanupObject[],
  reason: string,
  originalError?: unknown
) {
  try {
    await enqueueCapturedObjectsForCleanupDetached(
      image.id,
      created,
      reason
    );
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

export async function readStorageMigrationState(
  imageId: string
): Promise<StorageMigrationState | undefined> {
  return (await pool.query(
    `SELECT storage_slug, object_key, status
       FROM metadata
      WHERE id=$1`,
    [imageId]
  )).rows[0] as StorageMigrationState | undefined;
}

export function hasStorageMigrationLocation(
  state: StorageMigrationState,
  storageSlug: string,
  objectKey: string
) {
  return state.storage_slug === storageSlug
    && state.object_key === objectKey;
}

export function storageMigrationOutcomeUnknown(
  image: StorageMigrationImageRecord,
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

export async function settleStorageMigrationSwitchError(
  image: StorageMigrationImageRecord,
  target: string,
  created: readonly CapturedMoveCleanupObject[],
  sourceCleanup: readonly CapturedMoveCleanupObject[],
  originalError: unknown
): Promise<StorageMigrationState> {
  let state: StorageMigrationState | undefined;
  try {
    state = await readStorageMigrationState(image.id);
  } catch (truthError) {
    throw storageMigrationOutcomeUnknown(image, target, originalError, {
      truth_error: errorMessage(truthError),
      target_candidates: created,
      retained_source_objects: sourceCleanup
    });
  }

  if (state && hasStorageMigrationLocation(state, target, image.object_key)) {
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
    return state;
  }

  if (
    state
    && hasStorageMigrationLocation(state, image.storage_slug, image.object_key)
  ) {
    await queueStorageMigrationCandidateCleanup(
      image,
      target,
      created,
      "storage_migration_rolled_back",
      originalError
    );
    throw originalError;
  }

  throw storageMigrationOutcomeUnknown(image, target, originalError, {
    actual_storage_slug: state?.storage_slug ?? null,
    actual_object_key: state?.object_key ?? null,
    actual_status: state?.status ?? null,
    target_candidates: created,
    retained_source_objects: sourceCleanup
  });
}
