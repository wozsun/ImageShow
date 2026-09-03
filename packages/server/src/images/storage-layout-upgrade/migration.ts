import {
  storageLayoutUpgradeBatchMaxItems,
  type StorageLayoutUpgradeBatchResponseDto,
  type StorageLayoutUpgradeItemResultDto
} from "@imageshow/shared/browser";
import { ApiError, errorMessage } from "../../core/api-error.ts";
import {
  runWithAdvisoryLockAcquisitionSignal
} from "../../core/database/advisory-locks.ts";
import { pool } from "../../core/database/pools.ts";
import { withTransaction } from "../../core/database/transactions.ts";
import { logger } from "../../core/logger.ts";
import {
  imageStorageMutationLockKey,
  withStorageLocationWriteAndAdvisoryLock,
  withStorageLocationWriteLock
} from "../../storage/maintenance-lock.ts";
import { resolveStorageAccess } from "../../storage/backends/registry.ts";
import {
  captureMoveCleanupObjects,
  enqueueCapturedObjectsForCleanup,
  enqueueCapturedObjectsForCleanupWithoutLocationLock,
  type CapturedMoveCleanupObject
} from "../../storage/cleanup/service.ts";
import {
  isLegacyImageObjectKey,
  isStableImageObjectKey,
  storageObjectKey,
  thumbnailObjectKey
} from "../../storage/objects/image-paths.ts";
import { isStorageObjectNotFound } from "../../storage/objects/not-found.ts";
import {
  copyVerifiedObjectWithinStorage,
  missingThumbnailSourceError
} from "../../storage/objects/transfer.ts";
import { withImageMutationSync } from "../mutation-sync.ts";
import { bumpReadyImageRevision } from "../ready-cache/revision.ts";
import { activeIngestionStorageReferences } from "../ingestion/cleanup/storage-references.ts";
import { readStorageLayoutUpgradeStatus } from "./status.ts";

type StorageLayoutUpgradeImage = {
  id: string;
  object_key: string;
  ext: string;
  storage_slug: string;
  md5: string;
  image_size: string | number;
  thumbnail_size: string | number;
  status: string;
};

const storageLayoutUpgradeColumns = [
  "id",
  "object_key",
  "ext",
  "storage_slug",
  "md5",
  "image_size",
  "thumbnail_size",
  "status"
].join(", ");

function storageLayoutSourceMissing(image: StorageLayoutUpgradeImage) {
  return new ApiError(
    409,
    "storage_layout_upgrade_source_missing",
    "旧 media 完整图片不存在，请先核对存储状态",
    {
      image_id: image.id,
      backend: image.storage_slug,
      prefix: "media",
      key: image.object_key
    }
  );
}

async function enqueueUpgradeCandidateCleanup(
  image: StorageLayoutUpgradeImage,
  objects: readonly CapturedMoveCleanupObject[],
  reason: string,
  originalError?: unknown
) {
  try {
    await enqueueCapturedObjectsForCleanupWithoutLocationLock(
      image.id,
      objects,
      reason
    );
  } catch (cleanupError) {
    logger.error("storage_layout_upgrade_candidate_cleanup_failed", {
      image_id: image.id,
      backend: image.storage_slug,
      original_error: originalError ? errorMessage(originalError) : "",
      cleanup_error: errorMessage(cleanupError),
      objects
    });
    if (originalError) {
      throw new AggregateError(
        [originalError, cleanupError],
        "Storage layout upgrade failed and candidate cleanup could not be queued"
      );
    }
    throw cleanupError;
  }
}

async function readCurrentImage(imageId: string) {
  return (await pool.query(
    `SELECT ${storageLayoutUpgradeColumns}
       FROM metadata
      WHERE id=$1`,
    [imageId]
  )).rows[0] as StorageLayoutUpgradeImage | undefined;
}

async function settleUpgradeError(
  source: StorageLayoutUpgradeImage,
  targetObjectKey: string,
  createdObjects: readonly CapturedMoveCleanupObject[],
  sourceObjects: readonly CapturedMoveCleanupObject[],
  originalError: unknown
): Promise<"migrated"> {
  let current: StorageLayoutUpgradeImage | undefined;
  try {
    current = await readCurrentImage(source.id);
  } catch (truthError) {
    throw new ApiError(
      503,
      "storage_layout_upgrade_outcome_unknown",
      "布局升级结果暂时无法确认，已保留新旧对象供重试核对",
      {
        image_id: source.id,
        original_error: errorMessage(originalError),
        truth_error: errorMessage(truthError)
      }
    );
  }

  if (
    current?.storage_slug === source.storage_slug
    && current.object_key === targetObjectKey
  ) {
    await enqueueCapturedObjectsForCleanup(
      source.id,
      sourceObjects,
      "storage_layout_upgrade_source_cleanup_after_commit"
    );
    return "migrated";
  }

  if (
    current?.storage_slug === source.storage_slug
    && current.object_key === source.object_key
  ) {
    await enqueueUpgradeCandidateCleanup(
      source,
      createdObjects,
      "storage_layout_upgrade_rolled_back",
      originalError
    );
    throw originalError;
  }

  throw new ApiError(
    503,
    "storage_layout_upgrade_outcome_unknown",
    "图片位置已发生其他变化，已保留新旧对象供人工核对",
    {
      image_id: source.id,
      expected_source_key: source.object_key,
      expected_target_key: targetObjectKey,
      actual_storage_slug: current?.storage_slug ?? null,
      actual_object_key: current?.object_key ?? null,
      original_error: errorMessage(originalError)
    }
  );
}

async function migrateStorageLayoutImageWhileLocked(
  requested: StorageLayoutUpgradeImage,
  signal: AbortSignal
): Promise<"migrated" | "unchanged"> {
  signal.throwIfAborted();
  const current = await readCurrentImage(requested.id);
  signal.throwIfAborted();
  if (!current || isStableImageObjectKey(current.object_key)) {
    return "unchanged";
  }
  if (!isLegacyImageObjectKey(current.object_key)) {
    throw new ApiError(
      409,
      "storage_layout_upgrade_key_invalid",
      "图片对象键既不属于旧布局也不属于新布局",
      { image_id: requested.id, object_key: current.object_key }
    );
  }

  const targetObjectKey = storageObjectKey(current.id, current.ext);
  const sourceThumbnailKey = thumbnailObjectKey(current.object_key);
  const targetThumbnailKey = thumbnailObjectKey(targetObjectKey);
  const storage = await resolveStorageAccess(current.storage_slug);
  signal.throwIfAborted();
  const [targetImageObject, targetThumbnailObject] =
    await captureMoveCleanupObjects([
      {
        prefix: "full",
        key: targetObjectKey,
        backend: current.storage_slug
      },
      {
        prefix: "thumbs",
        key: targetThumbnailKey,
        backend: current.storage_slug
      }
    ]);
  const sourceObjects = await captureMoveCleanupObjects([
    {
      prefix: "media",
      key: current.object_key,
      backend: current.storage_slug
    },
    {
      prefix: "thumbs",
      key: sourceThumbnailKey,
      backend: current.storage_slug
    }
  ]);
  if (!targetImageObject || !targetThumbnailObject) {
    throw new Error("Storage layout upgrade target capture was incomplete");
  }
  const createdObjects: CapturedMoveCleanupObject[] = [];

  try {
    let imageTransfer;
    try {
      imageTransfer = await copyVerifiedObjectWithinStorage({
        storage,
        fromPrefix: "media",
        fromKey: current.object_key,
        toPrefix: "full",
        toKey: targetObjectKey,
        expectedSource: {
          size: Number(current.image_size),
          md5: current.md5
        },
        cleanupCandidate: (_object, cleanupOptions) => (
          enqueueCapturedObjectsForCleanupWithoutLocationLock(
            current.id,
            [targetImageObject],
            "storage_layout_upgrade_image_copy_failed",
            cleanupOptions
          )
        ),
        signal
      });
    } catch (error) {
      if (isStorageObjectNotFound(error)) {
        throw storageLayoutSourceMissing(current);
      }
      throw error;
    }
    if (imageTransfer.created) createdObjects.push(targetImageObject);
    signal.throwIfAborted();

    let thumbnailTransfer;
    try {
      thumbnailTransfer = await copyVerifiedObjectWithinStorage({
        storage,
        fromPrefix: "thumbs",
        fromKey: sourceThumbnailKey,
        toPrefix: "thumbs",
        toKey: targetThumbnailKey,
        expectedSource: { size: Number(current.thumbnail_size) },
        cleanupCandidate: (_object, cleanupOptions) => (
          enqueueCapturedObjectsForCleanupWithoutLocationLock(
            current.id,
            [targetThumbnailObject],
            "storage_layout_upgrade_thumbnail_copy_failed",
            cleanupOptions
          )
        ),
        signal
      });
    } catch (error) {
      if (isStorageObjectNotFound(error)) {
        throw missingThumbnailSourceError({
          imageId: current.id,
          backend: current.storage_slug,
          key: sourceThumbnailKey
        });
      }
      throw error;
    }
    if (thumbnailTransfer.created) createdObjects.push(targetThumbnailObject);
    signal.throwIfAborted();

    const migrated = await withImageMutationSync(async (mutationBatch) => {
      const changed = await withTransaction(async (client) => {
        signal.throwIfAborted();
        const updated = await client.query(
          `UPDATE metadata
              SET object_key=$2,
                  updated_at=now()
            WHERE id=$1
              AND storage_slug=$3
              AND object_key=$4
              AND status=$5
            RETURNING status`,
          [
            current.id,
            targetObjectKey,
            current.storage_slug,
            current.object_key,
            current.status
          ]
        );
        if (!updated.rowCount) return false;
        await enqueueCapturedObjectsForCleanup(
          current.id,
          sourceObjects,
          "storage_layout_upgrade_source_cleanup",
          client
        );
        if (current.status === "ready") {
          await bumpReadyImageRevision(client);
        }
        signal.throwIfAborted();
        return true;
      });
      if (changed && current.status === "ready") {
        mutationBatch.add({ id: current.id });
      }
      return changed;
    });
    if (!migrated) {
      throw new ApiError(
        409,
        "storage_layout_upgrade_compare_and_swap_failed",
        "图片位置在布局升级提交前发生变化"
      );
    }
    return "migrated";
  } catch (error) {
    signal.throwIfAborted();
    return settleUpgradeError(
      current,
      targetObjectKey,
      createdObjects,
      sourceObjects,
      error
    );
  }
}

async function assertStorageLayoutUpgradeWindow(signal: AbortSignal) {
  const [keysResult, ingestion] = await Promise.all([
    pool.query<{ object_key: string }>(
      `SELECT object_key
         FROM metadata
        WHERE status IN ('ready', 'deleted')`
    ),
    activeIngestionStorageReferences({ signal })
  ]);
  signal.throwIfAborted();
  const invalidLayoutImages = keysResult.rows.filter((row) => (
    !isLegacyImageObjectKey(row.object_key)
    && !isStableImageObjectKey(row.object_key)
  )).length;
  if (invalidLayoutImages) {
    throw new ApiError(
      409,
      "storage_layout_upgrade_invalid_keys",
      "存在无法识别布局的图片对象键，升级已停止",
      { count: invalidLayoutImages }
    );
  }
  const activeLegacyIngestions = ingestion.rows.filter((row) => (
    row.final_object_key
    && isLegacyImageObjectKey(row.final_object_key)
  )).length;
  if (activeLegacyIngestions) {
    throw new ApiError(
      409,
      "storage_layout_upgrade_ingestion_active",
      "仍有携带旧对象键的内容接入任务，请先让其完成或取消",
      { count: activeLegacyIngestions }
    );
  }
}

function publicUpgradeFailure(error: unknown) {
  return error instanceof ApiError
    ? { code: error.code, message: error.message }
    : {
        code: "storage_layout_upgrade_failed",
        message: "图片存储布局升级失败"
      };
}

export async function migrateStorageLayoutBatch(
  limit: number,
  requestSignal: AbortSignal
): Promise<StorageLayoutUpgradeBatchResponseDto> {
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || limit > storageLayoutUpgradeBatchMaxItems
  ) {
    throw new RangeError("Storage layout upgrade batch size is invalid");
  }
  requestSignal.throwIfAborted();
  return runWithAdvisoryLockAcquisitionSignal(
    requestSignal,
    () => withStorageLocationWriteLock(async (lockSignal) => {
      const signal = AbortSignal.any([requestSignal, lockSignal]);
      await assertStorageLayoutUpgradeWindow(signal);
      const requested = (await pool.query(
        `SELECT ${storageLayoutUpgradeColumns}
           FROM metadata
          WHERE status IN ('ready', 'deleted')
            AND (object_key LIKE 'pc-%' OR object_key LIKE 'mb-%')
          ORDER BY id
          LIMIT $1`,
        [limit]
      )).rows as StorageLayoutUpgradeImage[];
      signal.throwIfAborted();
      const results: StorageLayoutUpgradeItemResultDto[] = [];
      for (const image of requested) {
        signal.throwIfAborted();
        try {
          const status = await withStorageLocationWriteAndAdvisoryLock(
            imageStorageMutationLockKey(image.id),
            (itemSignal) => migrateStorageLayoutImageWhileLocked(
              image,
              AbortSignal.any([signal, itemSignal])
            )
          );
          results.push({ id: image.id, status });
        } catch (error) {
          signal.throwIfAborted();
          logger.warn("storage_layout_upgrade_item_failed", {
            image_id: image.id,
            backend: image.storage_slug,
            object_key: image.object_key,
            error: errorMessage(error)
          });
          results.push({
            id: image.id,
            status: "failed",
            ...publicUpgradeFailure(error)
          });
        }
      }
      const migrated = results.filter((item) => item.status === "migrated").length;
      const unchanged = results.filter((item) => item.status === "unchanged").length;
      const failed = results.length - migrated - unchanged;
      return {
        batch: {
          requested: requested.length,
          migrated,
          unchanged,
          failed,
          results
        },
        status: await readStorageLayoutUpgradeStatus(signal)
      };
    })
  );
}
