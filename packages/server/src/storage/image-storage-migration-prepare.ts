import { ApiError } from "../core/api-error.ts";
import { pool } from "../core/database-pools.ts";
import { md5Buffer } from "../images/processing.ts";
import { repairStoredThumbnailWithLockHeld } from "../images/thumbnail-repair.ts";
import {
  assertStorageWriteTarget,
  getStorageBackend,
  resolveStorageAccessForConfig
} from "./backend-registry.ts";
import type {
  ImageStorageMigrationPreparation,
  StorageMigrationImageRecord
} from "./image-storage-migration-contract.ts";
import { storageMigrationColumns } from "./image-storage-migration-contract.ts";
import {
  queueStorageMigrationCandidateCleanup
} from "./image-storage-migration-settlement.ts";
import { thumbnailObjectKey } from "./image-paths.ts";
import {
  assertThumbnailRepairNotPending,
  captureMoveCleanupObjects,
  enqueueCapturedObjectsForCleanupDetached,
  type CapturedMoveCleanupObject,
  type MoveCleanupObjectInput
} from "./move-cleanup.ts";
import { contentType, type StoragePrefix } from "./object-keys.ts";
import { ensureVerifiedObjectAtDestination } from "./object-transfer.ts";
import { shareStorageNamespace } from "./storage-namespace.ts";

export async function prepareImageStorageMigration(
  requested: StorageMigrationImageRecord,
  target: string,
  expectedSource: string | undefined,
  signal: AbortSignal
): Promise<ImageStorageMigrationPreparation> {
  signal.throwIfAborted();
  const current = (await pool.query(
    `SELECT ${storageMigrationColumns} FROM metadata WHERE id=$1`,
    [requested.id]
  )).rows[0] as StorageMigrationImageRecord | undefined;
  signal.throwIfAborted();
  if (!current) return { status: "missing" };
  if (expectedSource && current.storage_slug !== expectedSource) {
    return { status: "unchanged" };
  }
  if (current.storage_slug === target) return { status: "unchanged" };

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
    objectContentType: string,
    sourceObjectExists = true
  ) => {
    signal.throwIfAborted();
    const [capturedCandidate] = await captureMoveCleanupObjects([{
      prefix,
      key,
      backend: target
    }]);
    if (!capturedCandidate) {
      throw new Error("Migration candidate namespace could not be captured");
    }
    const result = await ensureVerifiedObjectAtDestination({
      source: sourceAccess,
      target: destinationAccess,
      prefix,
      key,
      body,
      contentType: objectContentType,
      sourceObjectExists,
      cleanupCandidate: () => enqueueCapturedObjectsForCleanupDetached(
        current.id,
        [capturedCandidate],
        "storage_migration_integrity_failure"
      ),
      signal
    });
    if (result.created) created.push(capturedCandidate);
    signal.throwIfAborted();
  };

  let sourceCleanup: CapturedMoveCleanupObject[];
  try {
    await assertThumbnailRepairNotPending(current.id, source, thumbKey);
    signal.throwIfAborted();
    if (!await sourceAccess.driver.exists(
      "media",
      current.object_key,
      { signal }
    )) {
      return { status: "missing" };
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
    await materialize(
      "media",
      current.object_key,
      image,
      contentType(current.ext)
    );

    const sourceThumbExists = await sourceAccess.driver.exists(
      "thumbs",
      thumbKey,
      { signal }
    );
    const thumbnail = sourceThumbExists
      ? await sourceAccess.driver.readBuffer("thumbs", thumbKey, { signal })
      : (await repairStoredThumbnailWithLockHeld(
          current.id,
          signal,
          {
            expectedLocation: {
              objectKey: current.object_key,
              storageSlug: current.storage_slug
            },
            sourceBuffer: image
          }
        )).thumbnail;
    thumbnailSize = thumbnail.byteLength;
    signal.throwIfAborted();
    await materialize(
      "thumbs",
      thumbKey,
      thumbnail,
      "image/webp",
      true
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
    await queueStorageMigrationCandidateCleanup(
      current,
      target,
      created,
      "storage_migration_prepare_failed",
      error
    );
    throw error;
  }

  return {
    status: "prepared",
    migration: {
      image: current,
      target,
      created,
      sourceCleanup,
      thumbnailSize
    }
  };
}
