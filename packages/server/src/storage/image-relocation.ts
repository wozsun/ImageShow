import type { Brightness, Device } from "@imageshow/shared";
import type { PoolClient } from "pg";
import { ApiError, errorMessage } from "../core/api-error.ts";
import { pool } from "../core/db.ts";
import { logger } from "../core/logger.ts";
import { createThumbnail, md5Buffer } from "../images/processing.ts";
import {
  storageObjectKey,
  thumbnailObjectKey
} from "./image-paths.ts";
import { resolveStorageAccess } from "./backend-registry.ts";
import {
  copyVerifiedObjectWithinStorage,
  ensureVerifiedObjectAtTarget
} from "./object-transfer.ts";
import {
  captureMoveCleanupObjects,
  enqueueObjectsForCleanup,
  enqueueCapturedObjectsForCleanup,
  type CapturedMoveCleanupObject,
  type MoveCleanupObjectInput
} from "./move-cleanup.ts";

export type RelocatableImage = {
  id: string;
  device: Device;
  brightness: Brightness;
  theme: string;
  ext: string;
  md5?: string | null;
  object_key: string;
  storage_slug: string;
};

export type ImageClassificationTarget = Pick<
  RelocatableImage,
  "device" | "brightness" | "theme"
>;

export type PreparedImageRelocation = {
  imageId: string;
  nextObjectKey: string;
  backend: string;
  target: ImageClassificationTarget;
  createdObjects: MoveCleanupObjectInput[];
  sourceObjects: CapturedMoveCleanupObject[];
};

function sourceMissingError(image: RelocatableImage, prefix: string, key: string) {
  return new ApiError(
    502,
    "storage_source_object_missing",
    "图片当前位置的源对象不存在",
    {
      image_id: image.id,
      backend: image.storage_slug,
      prefix,
      key
    }
  );
}

function uniqueObjects(objects: MoveCleanupObjectInput[]) {
  const seen = new Set<string>();
  return objects.filter((object) => {
    const identity = `${object.backend}:${object.prefix}:${object.key}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/**
 * Prepare every destination object and verify it before the caller performs
 * its metadata compare-and-swap. No source is deleted in this phase.
 */
export async function prepareVerifiedImageRelocation(
  image: RelocatableImage,
  target: ImageClassificationTarget,
  operation: string,
  signal?: AbortSignal
): Promise<PreparedImageRelocation> {
  signal?.throwIfAborted();
  const storage = await resolveStorageAccess(image.storage_slug);
  signal?.throwIfAborted();
  const createdObjects: MoveCleanupObjectInput[] = [];
  const sourceObjects: MoveCleanupObjectInput[] = [];
  let capturedSourceObjects: CapturedMoveCleanupObject[] = [];
  const nextObjectKey = storageObjectKey(
    target.device,
    target.brightness,
    target.theme,
    image.id,
    image.ext
  );
  const cleanupCandidate = (object: MoveCleanupObjectInput) =>
    enqueueObjectsForCleanup(
      image.id,
      [object],
      `${operation}_candidate_integrity_failure`
    );

  try {
    signal?.throwIfAborted();
    if (nextObjectKey !== image.object_key) {
      if (!await storage.driver.exists("media", image.object_key)) {
        throw sourceMissingError(image, "media", image.object_key);
      }
      const mediaResult = await copyVerifiedObjectWithinStorage({
        storage,
        fromPrefix: "media",
        fromKey: image.object_key,
        toPrefix: "media",
        toKey: nextObjectKey,
        expectedSource: { md5: image.md5 ?? undefined },
        cleanupCandidate
      });
      signal?.throwIfAborted();
      if (mediaResult.created) {
        createdObjects.push({
          prefix: "media",
          key: nextObjectKey,
          backend: image.storage_slug
        });
      }
      sourceObjects.push({
        prefix: "media",
        key: image.object_key,
        backend: image.storage_slug
      });

      const sourceThumbnailKey = thumbnailObjectKey(image.object_key);
      const targetThumbnailKey = thumbnailObjectKey(nextObjectKey);
      if (await storage.driver.exists("thumbs", sourceThumbnailKey)) {
        const thumbnailResult = await copyVerifiedObjectWithinStorage({
          storage,
          fromPrefix: "thumbs",
          fromKey: sourceThumbnailKey,
          toPrefix: "thumbs",
          toKey: targetThumbnailKey,
          cleanupCandidate
        });
        signal?.throwIfAborted();
        if (thumbnailResult.created) {
          createdObjects.push({
            prefix: "thumbs",
            key: targetThumbnailKey,
            backend: image.storage_slug
          });
        }
        sourceObjects.push({
          prefix: "thumbs",
          key: sourceThumbnailKey,
          backend: image.storage_slug
        });
      } else {
        const media = await storage.driver.readBuffer("media", image.object_key);
        signal?.throwIfAborted();
        if (image.md5 && md5Buffer(media) !== image.md5) {
          throw new ApiError(
            502,
            "storage_source_integrity_failed",
            "源存储对象与数据库记录的 MD5 不一致",
            { image_id: image.id, object_key: image.object_key }
          );
        }
        const thumbnail = await createThumbnail(media);
        signal?.throwIfAborted();
        const thumbnailResult = await ensureVerifiedObjectAtTarget({
          target: storage,
          prefix: "thumbs",
          key: targetThumbnailKey,
          body: thumbnail,
          contentType: "image/webp",
          cleanupCandidate
        });
        signal?.throwIfAborted();
        if (thumbnailResult.created) {
          createdObjects.push({
            prefix: "thumbs",
            key: targetThumbnailKey,
            backend: image.storage_slug
          });
        }
      }
    }
    capturedSourceObjects = await captureMoveCleanupObjects(
      uniqueObjects(sourceObjects)
    );
  } catch (error) {
    try {
      await enqueueObjectsForCleanup(
        image.id,
        uniqueObjects(createdObjects),
        `${operation}_prepare_failed`
      );
    } catch (cleanupError) {
      logger.error("image_relocation_candidate_enqueue_failed", {
        image_id: image.id,
        backend: image.storage_slug,
        operation,
        error: errorMessage(error),
        cleanup_error: errorMessage(cleanupError),
        candidates: uniqueObjects(createdObjects)
      });
      throw new AggregateError(
        [error, cleanupError],
        "Image relocation failed and candidate cleanup could not be queued"
      );
    }
    throw error;
  }

  return {
    imageId: image.id,
    nextObjectKey,
    backend: image.storage_slug,
    target,
    createdObjects: uniqueObjects(createdObjects),
    sourceObjects: capturedSourceObjects
  };
}

/** Remove only destination objects created by this operation. */
export function discardPreparedImageRelocation(
  relocation: PreparedImageRelocation,
  reason: string
) {
  return enqueueObjectsForCleanup(
    relocation.imageId,
    relocation.createdObjects,
    reason
  );
}

/**
 * A database transport/commit error can be ambiguous: PostgreSQL may have
 * committed even if the caller did not receive the acknowledgement. Re-read
 * ownership before compensating, and prefer a harmless duplicate over
 * deleting a destination that became authoritative.
 */
export async function discardPreparedImageRelocationIfUnreferenced(
  relocation: PreparedImageRelocation,
  reason: string
) {
  try {
    const adopted = await pool.query(
      `SELECT 1
         FROM metadata
        WHERE id=$1
          AND storage_slug=$2
          AND object_key=$3
          AND device=$4
          AND brightness=$5
          AND theme=$6`,
      [
        relocation.imageId,
        relocation.backend,
        relocation.nextObjectKey,
        relocation.target.device,
        relocation.target.brightness,
        relocation.target.theme
      ]
    );
    if (adopted.rowCount) return;
  } catch (error) {
    logger.error("image_relocation_candidate_ownership_unknown", {
      image_id: relocation.imageId,
      backend: relocation.backend,
      object_key: relocation.nextObjectKey,
      reason,
      error: errorMessage(error),
      candidates: relocation.createdObjects.map((object) => ({
        prefix: object.prefix,
        key: object.key
      }))
    });
    return;
  }
  await discardPreparedImageRelocation(relocation, reason);
}

/**
 * Persist old-object deletion in the same PostgreSQL transaction that switches
 * metadata ownership. A lost COMMIT response therefore cannot leave an adopted
 * destination without its durable cleanup receipt.
 */
export function enqueuePreparedImageSourceCleanup(
  client: PoolClient,
  relocation: PreparedImageRelocation,
  reason: string
) {
  return enqueueCapturedObjectsForCleanup(
    relocation.imageId,
    relocation.sourceObjects,
    reason,
    client
  );
}
