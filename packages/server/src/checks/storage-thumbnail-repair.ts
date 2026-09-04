import { ApiError, errorMessage } from "../core/api-error.ts";
import { pool } from "../core/database/pools.ts";
import { withNormalizationAdmission } from "../images/normalization-admission.ts";
import { createThumbnail, md5Buffer, sha256Buffer } from "../images/processing.ts";
import { resolveStorageAccess } from "../storage/backends/registry.ts";
import { thumbnailObjectKey } from "../storage/objects/image-paths.ts";
import { assertObjectNotPendingCleanup } from "../storage/cleanup/service.ts";
import {
  assertStorageRemovalResults,
  removeStorageObjectsAndConfirm
} from "../storage/objects/access.ts";
import {
  digestStorageObject,
  type StorageAccess
} from "../storage/objects/transfer.ts";
import type {
  MaintenanceImage,
  MaintenanceItem
} from "./storage-maintenance-plan.ts";

async function readThumbnailAuthority(imageId: string) {
  return (await pool.query<MaintenanceImage>(
    `SELECT id, object_key, status, storage_slug, md5, thumbnail_size
       FROM metadata
      WHERE id=$1`,
    [imageId]
  )).rows[0];
}

function sameThumbnailAuthority(
  before: MaintenanceImage,
  after: MaintenanceImage | undefined
) {
  return Boolean(
    after
    && (after.status === "ready" || after.status === "deleted")
    && after.object_key === before.object_key
    && after.storage_slug === before.storage_slug
  );
}

async function cleanupFailedThumbnailWrite(
  storage: StorageAccess,
  key: string,
  signal: AbortSignal,
  failure: unknown
): Promise<never> {
  try {
    const results = await removeStorageObjectsAndConfirm(
      [{ prefix: "thumbs", key, storageSlug: storage.config.slug }],
      { signal }
    );
    assertStorageRemovalResults(
      results,
      "无法确认失败的缩略图候选已清理"
    );
  } catch (cleanupError) {
    signal.throwIfAborted();
    throw new AggregateError(
      [failure, cleanupError],
      "缩略图写入失败，且无法确认候选对象已清理"
    );
  }
  throw failure;
}

async function writeVerifiedThumbnail(
  storage: StorageAccess,
  key: string,
  body: Buffer,
  signal: AbortSignal
) {
  signal.throwIfAborted();

  let writeFailure: unknown;
  try {
    await storage.driver.writeBuffer(
      "thumbs",
      key,
      body,
      "image/webp",
      { signal }
    );
  } catch (error) {
    signal.throwIfAborted();
    writeFailure = error;
  }

  let digest;
  try {
    digest = await digestStorageObject(storage, "thumbs", key, { signal });
  } catch (error) {
    signal.throwIfAborted();
    return cleanupFailedThumbnailWrite(
      storage,
      key,
      signal,
      writeFailure ?? error
    );
  }
  const matches = digest.size === body.byteLength
    && digest.sha256 === sha256Buffer(body);
  if (!matches) {
    return cleanupFailedThumbnailWrite(
      storage,
      key,
      signal,
      new ApiError(
        502,
        "storage_transfer_integrity_failed",
        "缩略图写入后完整性校验失败",
        { backend: storage.config.slug, prefix: "thumbs", key }
      )
    );
  }
  return { responseRecovered: writeFailure !== undefined };
}

async function persistThumbnailSize(
  authority: MaintenanceImage,
  thumbnailSize: number,
  signal: AbortSignal
) {
  let updateFailure: unknown;
  try {
    const updated = await pool.query(
      `UPDATE metadata
          SET thumbnail_size=$2
        WHERE id=$1
          AND storage_slug=$3
          AND object_key=$4
          AND status IN ('ready','deleted')`,
      [
        authority.id,
        thumbnailSize,
        authority.storage_slug,
        authority.object_key
      ]
    );
    signal.throwIfAborted();
    if (updated.rowCount) return;
  } catch (error) {
    signal.throwIfAborted();
    updateFailure = error;
  }

  const current = await readThumbnailAuthority(authority.id);
  signal.throwIfAborted();
  if (
    sameThumbnailAuthority(authority, current)
    && Number(current?.thumbnail_size) === thumbnailSize
  ) {
    return;
  }
  if (updateFailure) throw updateFailure;
  throw new ApiError(
    409,
    "image_location_changed",
    "图片位置或缩略图状态在维修期间发生变化",
    { image_id: authority.id }
  );
}

export async function repairStorageThumbnail(
  imageId: string,
  scheduleSignal: AbortSignal,
  operationSignal: AbortSignal = scheduleSignal
): Promise<MaintenanceItem> {
  let authority: MaintenanceImage | undefined;
  try {
    scheduleSignal.throwIfAborted();
    operationSignal.throwIfAborted();
    authority = await readThumbnailAuthority(imageId);
    operationSignal.throwIfAborted();
    if (!authority) {
      return {
        action: "repair_thumbnail",
        outcome: "skipped",
        backend: "unknown",
        prefix: "thumbs",
        key: "*",
        image_id: imageId,
        reason: "图片记录已不存在"
      };
    }
    const thumbKey = thumbnailObjectKey(authority.object_key);
    const itemBase = {
      action: "repair_thumbnail" as const,
      backend: authority.storage_slug,
      prefix: "thumbs" as const,
      key: thumbKey,
      image_id: authority.id
    };
    if (authority.status !== "ready" && authority.status !== "deleted") {
      return { ...itemBase, outcome: "skipped", reason: "图片不再处于保留状态" };
    }

    const storage = await resolveStorageAccess(authority.storage_slug);
    operationSignal.throwIfAborted();
    await assertObjectNotPendingCleanup(storage.config, "thumbs", thumbKey);
    operationSignal.throwIfAborted();
    if (!await storage.driver.exists(
      "full",
      authority.object_key,
      { signal: operationSignal }
    )) {
      return { ...itemBase, outcome: "skipped", reason: "当前位置的原图不存在" };
    }
    if (
      Number(authority.thumbnail_size) > 0
      && await storage.driver.exists(
        "thumbs",
        thumbKey,
        { signal: operationSignal }
      )
    ) {
      return { ...itemBase, outcome: "skipped", reason: "缩略图已存在，无需维修" };
    }
    const sourceAuthority = authority;
    const thumbnail = await withNormalizationAdmission(
      scheduleSignal,
      async () => {
        const source = await storage.driver.readBuffer(
          "full",
          sourceAuthority.object_key,
          { signal: operationSignal }
        );
        operationSignal.throwIfAborted();
        if (sourceAuthority.md5 && md5Buffer(source) !== sourceAuthority.md5) {
          throw new ApiError(
            502,
            "storage_source_integrity_failed",
            "源存储对象与数据库记录的 MD5 不一致",
            {
              image_id: sourceAuthority.id,
              object_key: sourceAuthority.object_key
            }
          );
        }
        return createThumbnail(source);
      }
    );
    operationSignal.throwIfAborted();

    const current = await readThumbnailAuthority(authority.id);
    operationSignal.throwIfAborted();
    if (!sameThumbnailAuthority(authority, current)) {
      return { ...itemBase, outcome: "skipped", reason: "生成后图片位置或状态已变化" };
    }
    const currentStorage = await resolveStorageAccess(current!.storage_slug);
    operationSignal.throwIfAborted();
    const currentThumbnailExists = await currentStorage.driver.exists(
      "thumbs",
      thumbKey,
      { signal: operationSignal }
    );
    if (currentThumbnailExists && Number(current!.thumbnail_size) > 0) {
      return { ...itemBase, outcome: "skipped", reason: "生成期间缩略图已恢复" };
    }
    if (currentThumbnailExists) {
      const removals = await removeStorageObjectsAndConfirm(
        [{
          prefix: "thumbs",
          key: thumbKey,
          storageSlug: current!.storage_slug
        }],
        { signal: operationSignal }
      );
      assertStorageRemovalResults(removals);
      operationSignal.throwIfAborted();
    }
    await persistThumbnailSize(current!, 0, operationSignal);
    const pendingAuthority = { ...current!, thumbnail_size: 0 };
    const materialized = await writeVerifiedThumbnail(
      currentStorage,
      thumbKey,
      thumbnail,
      operationSignal
    );
    operationSignal.throwIfAborted();
    try {
      await persistThumbnailSize(
        pendingAuthority,
        thumbnail.byteLength,
        operationSignal
      );
    } catch (error) {
      operationSignal.throwIfAborted();
      return await cleanupFailedThumbnailWrite(
        currentStorage,
        thumbKey,
        operationSignal,
        error
      );
    }
    operationSignal.throwIfAborted();
    return {
      ...itemBase,
      outcome: "repaired",
      thumbnail_size: thumbnail.byteLength,
      ...(materialized.responseRecovered
        ? { reason: "写入响应丢失后已通过完整性回读确认" }
        : {})
    };
  } catch (error) {
    if (scheduleSignal.aborted) throw scheduleSignal.reason ?? error;
    if (operationSignal.aborted) throw operationSignal.reason ?? error;
    return {
      action: "repair_thumbnail",
      outcome: "failed",
      backend: authority?.storage_slug ?? "unknown",
      prefix: "thumbs",
      key: authority ? thumbnailObjectKey(authority.object_key) : "*",
      image_id: imageId,
      error: errorMessage(error)
    };
  }
}
