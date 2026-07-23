import { privateNoStoreCacheControl } from "../../core/http/headers.ts";
import { pool } from "../../core/db.ts";
import { thumbnailObjectKey } from "../../storage/image-paths.ts";
import { withStorageLocationReadLock } from "../../storage/maintenance-lock.ts";
import { enqueueObjectsForCleanup } from "../../storage/move-cleanup.ts";
import {
  listStorageKeys,
  readStorageBuffer,
  removeStorageObjectAndConfirm
} from "../../storage/object-access.ts";
import type { PreparedPayload } from "./types.ts";
import { stagingSessionId } from "./staging-keys.ts";

export async function preparedThumbnailResponse(
  payload: Pick<PreparedPayload, "prepared_thumbnail_key">,
  storageSlug: string
) {
  const buffer = await readStorageBuffer("_uploads", payload.prepared_thumbnail_key, storageSlug);
  return new Response(buffer as unknown as BodyInit, {
    headers: { "Content-Type": "image/webp", "Cache-Control": privateNoStoreCacheControl }
  });
}

async function removeStagingKeys(keys: string[], storageSlug: string) {
  return withStorageLocationReadLock(async (signal) => {
    const results = await Promise.allSettled(keys.map(async (key) => {
      signal.throwIfAborted();
      await removeStorageObjectAndConfirm("_uploads", key, storageSlug);
    }));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length) {
      throw new AggregateError(failures, "Import staging cleanup failed");
    }
  });
}

export function cleanupStagedAttempt(
  imageKey: string,
  thumbnailKey: string,
  storageSlug: string
) {
  return removeStagingKeys([imageKey, thumbnailKey], storageSlug);
}

export async function cleanupStagedObjects(id: string, storageSlug: string) {
  return withStorageLocationReadLock(async (signal) => {
    signal.throwIfAborted();
    const keys = (await listStorageKeys("_uploads", storageSlug))
      .filter((key) => stagingSessionId(key) === id);
    signal.throwIfAborted();
    await removeStagingKeys(keys, storageSlug);
  });
}

export async function cleanupFinalImportObjects(
  id: string,
  finalObjectKey: string,
  storageSlug: string
) {
  if (!finalObjectKey) return;
  const referenced = await pool.query(
    `SELECT 1
       FROM metadata
      WHERE storage_slug=$1 AND object_key=$2
      LIMIT 1`,
    [storageSlug, finalObjectKey]
  );
  if (referenced.rowCount) return;
  await enqueueObjectsForCleanup(id, [
    { prefix: "media", key: finalObjectKey, backend: storageSlug },
    {
      prefix: "thumbs",
      key: thumbnailObjectKey(finalObjectKey),
      backend: storageSlug
    }
  ], "expired_import_commit_cleanup");
}
