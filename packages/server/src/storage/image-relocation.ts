import type { Brightness, Device } from "@imageshow/shared/browser";
import type { PoolClient } from "pg";
import { ApiError, errorMessage } from "../core/api-error.ts";
import { pool } from "../core/db.ts";
import { logger } from "../core/logger.ts";
import { repairStoredThumbnailWithLockHeld } from "../images/thumbnail-repair.ts";
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
  assertThumbnailRepairNotPending,
  captureMoveCleanupObjects,
  enqueueCapturedObjectsForCleanupDetached,
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
  thumbnailSize: number | null;
  createdObjects: CapturedMoveCleanupObject[];
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

function uniqueObjects<T extends MoveCleanupObjectInput>(objects: T[]): T[] {
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
  const createdObjects: CapturedMoveCleanupObject[] = [];
  const sourceObjects: MoveCleanupObjectInput[] = [];
  let thumbnailSize: number | null = null;
  let capturedSourceObjects: CapturedMoveCleanupObject[] = [];
  const nextObjectKey = storageObjectKey(
    target.device,
    target.brightness,
    target.theme,
    image.id,
    image.ext
  );
  const captureCandidate = async (
    prefix: "media" | "thumbs",
    key: string
  ) => {
    const [captured] = await captureMoveCleanupObjects([{
      prefix,
      key,
      backend: image.storage_slug
    }]);
    if (!captured) throw new Error("Candidate namespace could not be captured");
    return captured;
  };
  const cleanupCandidate = (object: CapturedMoveCleanupObject) => () =>
    enqueueCapturedObjectsForCleanupDetached(
      image.id,
      [object],
      `${operation}_candidate_integrity_failure`
    );

  try {
    signal?.throwIfAborted();
    if (nextObjectKey !== image.object_key) {
      const sourceThumbnailKey = thumbnailObjectKey(image.object_key);
      await assertThumbnailRepairNotPending(
        image.id,
        storage.config,
        sourceThumbnailKey
      );
      signal?.throwIfAborted();
      if (!await storage.driver.exists(
        "media",
        image.object_key,
        { signal }
      )) {
        throw sourceMissingError(image, "media", image.object_key);
      }
      const mediaCandidate = await captureCandidate("media", nextObjectKey);
      const mediaResult = await copyVerifiedObjectWithinStorage({
        storage,
        fromPrefix: "media",
        fromKey: image.object_key,
        toPrefix: "media",
        toKey: nextObjectKey,
        expectedSource: { md5: image.md5 ?? undefined },
        cleanupCandidate: cleanupCandidate(mediaCandidate),
        signal
      });
      if (mediaResult.created) {
        createdObjects.push(mediaCandidate);
      }
      signal?.throwIfAborted();
      sourceObjects.push({
        prefix: "media",
        key: image.object_key,
        backend: image.storage_slug
      });

      const targetThumbnailKey = thumbnailObjectKey(nextObjectKey);
      if (await storage.driver.exists(
        "thumbs",
        sourceThumbnailKey,
        { signal }
      )) {
        const thumbnailCandidate = await captureCandidate(
          "thumbs",
          targetThumbnailKey
        );
        const thumbnailResult = await copyVerifiedObjectWithinStorage({
          storage,
          fromPrefix: "thumbs",
          fromKey: sourceThumbnailKey,
          toPrefix: "thumbs",
          toKey: targetThumbnailKey,
          cleanupCandidate: cleanupCandidate(thumbnailCandidate),
          signal
        });
        if (thumbnailResult.created) {
          createdObjects.push(thumbnailCandidate);
        }
        signal?.throwIfAborted();
        thumbnailSize = thumbnailResult.sourceDigest.size;
        sourceObjects.push({
          prefix: "thumbs",
          key: sourceThumbnailKey,
          backend: image.storage_slug
        });
      } else {
        const media = await storage.driver.readBuffer(
          "media",
          image.object_key,
          { signal }
        );
        signal?.throwIfAborted();
        const repair = await repairStoredThumbnailWithLockHeld(
          image.id,
          signal ?? new AbortController().signal,
          {
            expectedLocation: {
              objectKey: image.object_key,
              storageSlug: image.storage_slug
            },
            sourceBuffer: media
          }
        );
        signal?.throwIfAborted();
        const thumbnailCandidate = await captureCandidate(
          "thumbs",
          targetThumbnailKey
        );
        const thumbnailResult = await ensureVerifiedObjectAtTarget({
          target: storage,
          prefix: "thumbs",
          key: targetThumbnailKey,
          body: repair.thumbnail,
          contentType: "image/webp",
          cleanupCandidate: cleanupCandidate(thumbnailCandidate),
          signal
        });
        if (thumbnailResult.created) {
          createdObjects.push(thumbnailCandidate);
        }
        signal?.throwIfAborted();
        thumbnailSize = repair.thumbnailSize;
        sourceObjects.push({
          prefix: "thumbs",
          key: sourceThumbnailKey,
          backend: image.storage_slug
        });
      }
    }
    capturedSourceObjects = await captureMoveCleanupObjects(
      uniqueObjects(sourceObjects)
    );
  } catch (error) {
    try {
      await enqueueCapturedObjectsForCleanupDetached(
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
    thumbnailSize,
    createdObjects: uniqueObjects(createdObjects),
    sourceObjects: capturedSourceObjects
  };
}

/** Remove only destination objects created by this operation. */
export function discardPreparedImageRelocation(
  relocation: PreparedImageRelocation,
  reason: string
) {
  return enqueueCapturedObjectsForCleanupDetached(
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
