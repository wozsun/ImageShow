import { imageVariants } from "@imageshow/shared/browser";
import { neverAbortedSignal } from "../../core/abort.ts";
import { imageObjectKey } from "../../storage/objects/image-paths.ts";
import { imageVariantColumns, storedVariantFacts, type ImageVariantRecord } from "../variants/record.ts";
import { ApiError, errorMessage } from "../../core/api-error.ts";
import { runWithAdvisoryLockAcquisitionSignal } from "../../core/database/advisory-locks.ts";
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
import { withImageStorageMutationLock } from "../../storage/maintenance-lock.ts";
import {
  captureMoveCleanupObjects,
  enqueueCapturedObjectsForCleanup,
  enqueueCapturedObjectsForCleanupWithoutLocationLock,
  type CapturedMoveCleanupObject,
  type MoveCleanupObjectInput
} from "../../storage/cleanup/service.ts";
import { type ReadablePrefix } from "../../storage/objects/keys.ts";
import {
  ensureVerifiedObjectAtDestination
} from "../../storage/objects/transfer.ts";
import { shareStorageNamespace } from "../../storage/objects/namespace.ts";
import { withImageTransferAdmission } from "../../storage/objects/image-transfer-admission.ts";

export type ImageStorageMigrationRecord = ImageVariantRecord & {
  id: string;
  storage_slug: string;
};

export type ImageStorageMigrationResult = "migrated" | "unchanged" | "missing";

type ImageStorageLocationState = {
  storage_slug: string;
  status: string;
};

const imageStorageMigrationColumns = `id, storage_slug, ${imageVariantColumns}`;

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
      object_key: imageObjectKey(image.id),
      cleanup_reason: reason,
      ...(originalError
        ? { original_error: originalError }
        : {}),
      cleanup_error: cleanupError,
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
  return (
    await pool.query(
      `SELECT storage_slug, status
       FROM metadata
      WHERE id=$1`,
      [imageId]
    )
  ).rows[0] as ImageStorageLocationState | undefined;
}

function hasLocation(
  state: ImageStorageLocationState,
  storageSlug: string
) {
  return state.storage_slug === storageSlug;
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
    object_key: imageObjectKey(image.id),
    original_error: errorMessage(originalError),
    ...details
  };
  logger.error("storage_migration_outcome_unknown", { ...context, original_error: originalError });
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

  if (state && hasLocation(state, target)) {
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
        object_key: imageObjectKey(image.id),
        original_error: originalError,
        cleanup_error: cleanupError,
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
          object_key: imageObjectKey(image.id)
        }
      );
    }
    logger.warn("storage_migration_destination_adopted_after_error", {
      image_id: image.id,
      source_backend: image.storage_slug,
      target_backend: target,
      object_key: imageObjectKey(image.id),
      original_error: originalError
    });
    return state;
  }

  if (state && hasLocation(state, image.storage_slug)) {
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
  const current = (
    await pool.query(`SELECT ${imageStorageMigrationColumns} FROM metadata WHERE id=$1`, [
      requested.id
    ])
  ).rows[0] as ImageStorageMigrationRecord | undefined;
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
  const created: CapturedMoveCleanupObject[] = [];
  const sourceObjects: MoveCleanupObjectInput[] = [];

  const materialize = async (
    prefix: ReadablePrefix,
    key: string,
    expected: { size: string | number; md5?: string },
    objectContentType: string
  ) => {
    signal.throwIfAborted();
    const [candidate] = await captureMoveCleanupObjects([
      {
        prefix,
        key,
        backend: target
      }
    ]);
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
      cleanupCandidate: (_object, cleanupOptions) =>
        enqueueCapturedObjectsForCleanupWithoutLocationLock(
          current.id,
          [candidate],
          "storage_migration_integrity_failure",
          cleanupOptions
        ),
      signal
    });
    if (result.created) created.push(candidate);
    signal.throwIfAborted();
  };

  let sourceCleanup: CapturedMoveCleanupObject[];
  try {
    for (const variant of imageVariants) {
      const facts = storedVariantFacts(current, variant);
      const key = imageObjectKey(current.id);
      await materialize(variant, key, { size: facts.byte_size, md5: facts.md5 }, "image/webp");
      if (!sharedNamespace) sourceObjects.push({ prefix: variant, key, backend: current.storage_slug });
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
    if (error instanceof ApiError && error.code === "storage_source_object_not_found") return "missing";
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
          RETURNING status`,
          [
            current.id,
            target,
            current.storage_slug
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
    if (state && hasLocation(state, target)) {
      await enqueueCapturedObjectsForCleanup(
        current.id,
        sourceCleanup,
        "source_cleanup_after_storage_switch"
      );
      return finish(state.status);
    }
    if (state && hasLocation(
      state,
      current.storage_slug
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
  const migrateWithImageLock = () =>
    withImageStorageMutationLock(image.id, async (lockSignal) => {
      const operationSignal = options.signal
        ? AbortSignal.any([options.signal, lockSignal])
        : lockSignal;
      return migrateImageToStorageBackendWhileLocked(
        image,
        target,
        options.expectedSource,
        operationSignal
      );
    });
  const signal = options.signal ?? neverAbortedSignal;
  return withImageTransferAdmission(signal, () =>
    options.signal
      ? runWithAdvisoryLockAcquisitionSignal(
          options.signal,
          migrateWithImageLock
        )
      : migrateWithImageLock()
  );
}
