import { privateNoStoreCacheControl } from "../../core/http/headers.ts";
import { pool } from "../../core/db.ts";
import { mapWithWorkerPool } from "../../core/concurrency.ts";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
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
import {
  appendImportCleanupFailure,
  type ImportCleanupFailures
} from "./cleanup-failures.ts";

export async function preparedThumbnailResponse(
  payload: Pick<PreparedPayload, "prepared_thumbnail_key">,
  storageSlug: string
) {
  const buffer = await readStorageBuffer("_uploads", payload.prepared_thumbnail_key, storageSlug);
  return new Response(buffer as unknown as BodyInit, {
    headers: { "Content-Type": "image/webp", "Cache-Control": privateNoStoreCacheControl }
  });
}

async function removeStagingKeysWithinLock(
  entries: readonly { id: string; key: string }[],
  storageSlug: string,
  signal: AbortSignal
) {
  const failures: ImportCleanupFailures = new Map();
  await mapWithWorkerPool(
    entries,
    getRuntimeConfig().background_job.move_cleanup_concurrency,
    async ({ id, key }) => {
      try {
        signal.throwIfAborted();
        await removeStorageObjectAndConfirm("_uploads", key, storageSlug);
      } catch (error) {
        appendImportCleanupFailure(failures, id, error);
      }
    },
    { signal }
  );
  return failures;
}

async function removeStagingKeys(keys: string[], storageSlug: string) {
  return withStorageLocationReadLock(async (signal) => {
    const failures = await removeStagingKeysWithinLock(
      keys.map((key) => ({ id: stagingSessionId(key), key })),
      storageSlug,
      signal
    );
    const reasons = [...failures.values()].flat();
    if (reasons.length) {
      throw new AggregateError(reasons, "Import staging cleanup failed");
    }
  });
}

export async function cleanupStagedObjectsBatch(
  ids: readonly string[],
  storageSlug: string
) {
  const targets = new Set(ids);
  const failures: ImportCleanupFailures = new Map();
  if (!targets.size) return failures;

  try {
    await withStorageLocationReadLock(async (signal) => {
      signal.throwIfAborted();
      const entries = (await listStorageKeys("_uploads", storageSlug))
        .map((key) => ({ id: stagingSessionId(key), key }))
        .filter(({ id }) => targets.has(id));
      signal.throwIfAborted();
      const deleteFailures = await removeStagingKeysWithinLock(
        entries,
        storageSlug,
        signal
      );
      for (const [id, errors] of deleteFailures) {
        failures.set(id, errors);
      }
    });
  } catch (error) {
    for (const id of targets) {
      appendImportCleanupFailure(failures, id, error);
    }
  }
  return failures;
}

export function cleanupStagedAttempt(
  imageKey: string,
  thumbnailKey: string,
  storageSlug: string
) {
  return removeStagingKeys([imageKey, thumbnailKey], storageSlug);
}

export async function cleanupStagedObjects(id: string, storageSlug: string) {
  const failures = await cleanupStagedObjectsBatch([id], storageSlug);
  const reasons = failures.get(id) ?? [];
  if (reasons.length) {
    throw new AggregateError(reasons, "Import staging cleanup failed");
  }
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
