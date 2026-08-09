import { ApiError } from "../core/api-error.ts";
import { pool } from "../core/db.ts";
import { resolveStorageAccess } from "../storage/backend-registry.ts";
import { thumbnailObjectKey } from "../storage/image-paths.ts";
import { withImageStorageMutationLock } from "../storage/maintenance-lock.ts";
import {
  enqueueThumbnailRepairWriteAhead,
  settleThumbnailRepairWriteAhead
} from "../storage/move-cleanup.ts";
import type { ThumbnailRepairCleanupAuthorization } from "../storage/move-cleanup.ts";
import {
  digestStorageObject,
  ensureVerifiedObjectAtTarget
} from "../storage/object-transfer.ts";
import { safeStoragePath } from "../storage/object-keys.ts";
import { createThumbnail, md5Buffer, sha256Buffer } from "./processing.ts";

type ThumbnailAuthority = {
  id: string;
  object_key: string;
  storage_slug: string;
  status: string;
  md5: string;
};

type ExpectedThumbnailLocation = {
  objectKey: string;
  storageSlug: string;
};

type ThumbnailRepairOptions = {
  expectedLocation?: ExpectedThumbnailLocation;
  sourceBuffer?: Buffer;
};

export type ThumbnailRepairResult = {
  thumbnail: Buffer;
  thumbnailSize: number;
  created: boolean;
  objectKey: string;
  storageSlug: string;
};

function assertExpectedLocation(
  authority: ThumbnailAuthority,
  expected: ExpectedThumbnailLocation | undefined
) {
  if (
    expected
    && (
      authority.object_key !== expected.objectKey
      || authority.storage_slug !== expected.storageSlug
    )
  ) {
    throw new ApiError(
      409,
      "image_location_changed",
      "Image location changed before thumbnail repair",
      { image_id: authority.id }
    );
  }
}

function assertSourceIntegrity(authority: ThumbnailAuthority, source: Buffer) {
  if (authority.md5 && md5Buffer(source) !== authority.md5) {
    throw new ApiError(
      502,
      "storage_source_integrity_failed",
      "源存储对象与数据库记录的 MD5 不一致",
      { image_id: authority.id, object_key: authority.object_key }
    );
  }
}

async function persistThumbnailSize(
  authority: ThumbnailAuthority,
  thumbnailSize: number
) {
  const updated = await pool.query(
    `UPDATE metadata
        SET thumbnail_size=$2
      WHERE id=$1
        AND storage_slug=$3
        AND object_key=$4`,
    [
      authority.id,
      thumbnailSize,
      authority.storage_slug,
      authority.object_key
    ]
  );
  if (!updated.rowCount) {
    throw new ApiError(
      409,
      "image_location_changed",
      "Image location changed while repairing thumbnail"
    );
  }
}

/**
 * Repair while the caller owns this image's storage-mutation lock. Authority
 * is always re-read after lock acquisition; callers may pass a verified source
 * buffer only to avoid reading a large remote image twice.
 */
export async function repairStoredThumbnailWithLockHeld(
  imageId: string,
  signal: AbortSignal,
  options: ThumbnailRepairOptions = {}
): Promise<ThumbnailRepairResult> {
  signal.throwIfAborted();
  const authority = (await pool.query<ThumbnailAuthority>(
    `SELECT id, object_key, storage_slug, status, md5
       FROM metadata
      WHERE id=$1`,
    [imageId]
  )).rows[0];
  signal.throwIfAborted();
  if (!authority) {
    throw new ApiError(404, "not_found", "Image not found");
  }
  if (authority.status !== "ready" && authority.status !== "deleted") {
    throw new ApiError(
      409,
      "invalid_image_state",
      "Only retained images can repair a thumbnail"
    );
  }
  assertExpectedLocation(authority, options.expectedLocation);

  const storage = await resolveStorageAccess(authority.storage_slug);
  signal.throwIfAborted();
  if (!await storage.driver.exists("media", authority.object_key)) {
    throw new ApiError(
      502,
      "storage_source_object_missing",
      "图片当前位置的源对象不存在",
      {
        image_id: authority.id,
        backend: authority.storage_slug,
        prefix: "media",
        key: authority.object_key
      }
    );
  }
  signal.throwIfAborted();

  const thumbKey = thumbnailObjectKey(authority.object_key);
  let thumbnail: Buffer;
  let created = false;
  let repairAuthorization: ThumbnailRepairCleanupAuthorization | undefined;
  const thumbnailExists = await storage.driver.exists("thumbs", thumbKey);
  if (thumbnailExists) {
    thumbnail = await storage.driver.readBuffer("thumbs", thumbKey);
  } else {
    let input: Buffer | string;
    if (options.sourceBuffer) {
      assertSourceIntegrity(authority, options.sourceBuffer);
      input = options.sourceBuffer;
    } else if (storage.config.type === "local") {
      const sourceDigest = await digestStorageObject(
        storage,
        "media",
        authority.object_key,
        { includeMd5: true }
      );
      if (authority.md5 && sourceDigest.md5 !== authority.md5) {
        throw new ApiError(
          502,
          "storage_source_integrity_failed",
          "源存储对象与数据库记录的 MD5 不一致",
          { image_id: authority.id, object_key: authority.object_key }
        );
      }
      input = safeStoragePath("media", authority.object_key);
    } else {
      const source = await storage.driver.readBuffer("media", authority.object_key);
      assertSourceIntegrity(authority, source);
      input = source;
    }
    signal.throwIfAborted();
    thumbnail = await createThumbnail(input);
    signal.throwIfAborted();
    repairAuthorization = await enqueueThumbnailRepairWriteAhead(
      authority.id,
      {
        prefix: "thumbs",
        key: thumbKey,
        backend: authority.storage_slug,
        thumbnail_repair: {
          expected_sha256: sha256Buffer(thumbnail),
          expected_size: thumbnail.byteLength
        }
      },
      thumbnail
    );
  }

  if (!thumbnailExists) {
    const materialized = await ensureVerifiedObjectAtTarget({
      target: storage,
      prefix: "thumbs",
      key: thumbKey,
      body: thumbnail,
      contentType: "image/webp",
      repairAuthorization
    });
    created = materialized.created;
    signal.throwIfAborted();
  }
  await persistThumbnailSize(authority, thumbnail.byteLength);
  signal.throwIfAborted();
  if (repairAuthorization) {
    await settleThumbnailRepairWriteAhead(repairAuthorization, thumbnail);
    signal.throwIfAborted();
  }

  return {
    thumbnail,
    thumbnailSize: thumbnail.byteLength,
    created,
    objectKey: authority.object_key,
    storageSlug: authority.storage_slug
  };
}

export function repairStoredThumbnail(imageId: string) {
  return withImageStorageMutationLock(imageId, (signal) =>
    repairStoredThumbnailWithLockHeld(imageId, signal)
  );
}
