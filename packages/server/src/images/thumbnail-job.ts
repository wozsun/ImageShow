import { pool } from "../core/db.ts";
import {
  jobIgnored,
  jobSucceeded,
  type BackgroundJobOutcome
} from "../jobs/handler-outcome.ts";
import type { BackgroundJob } from "../jobs/types.ts";
import { resolveStorageAccess } from "../storage/backend-registry.ts";
import { thumbnailObjectKey } from "../storage/image-paths.ts";
import { withImageStorageMutationLock } from "../storage/maintenance-lock.ts";
import {
  createThumbnail,
  generateStoredThumbnail,
  md5Buffer
} from "./processing.ts";

async function generateThumbnailWhileLocked(
  job: BackgroundJob,
  signal: AbortSignal
): Promise<BackgroundJobOutcome> {
  signal.throwIfAborted();
  const row = (await pool.query(
    "SELECT object_key, status, storage_slug, md5 FROM metadata WHERE id=$1",
    [job.target_id]
  )).rows[0];
  signal.throwIfAborted();
  if (!row) return jobIgnored("metadata missing");
  if (row.status !== "ready") return jobIgnored("image not ready");
  const storage = await resolveStorageAccess(row.storage_slug);
  signal.throwIfAborted();
  if (!await storage.driver.exists("media", row.object_key)) {
    return jobIgnored("object missing");
  }
  signal.throwIfAborted();

  let thumbnailSize: number;
  if (storage.config.type !== "local") {
    const buffer = await storage.driver.readBuffer("media", row.object_key);
    signal.throwIfAborted();
    if (row.md5 && md5Buffer(buffer) !== row.md5) {
      throw new Error(
        "integrity check failed: stored object md5 does not match "
        + `recorded md5 (${row.md5})`
      );
    }
    const thumbnail = await createThumbnail(buffer);
    signal.throwIfAborted();
    await storage.driver.writeBuffer(
      "thumbs",
      thumbnailObjectKey(row.object_key),
      thumbnail,
      "image/webp"
    );
    signal.throwIfAborted();
    thumbnailSize = thumbnail.byteLength;
  } else {
    thumbnailSize = await generateStoredThumbnail(
      row.object_key,
      row.storage_slug
    );
    signal.throwIfAborted();
  }

  const updated = await pool.query(
    `UPDATE metadata
        SET thumbnail_size=$2
      WHERE id=$1
        AND status='ready'
        AND storage_slug=$3
        AND object_key=$4`,
    [job.target_id, thumbnailSize, row.storage_slug, row.object_key]
  );
  signal.throwIfAborted();
  if (!updated.rowCount) return jobIgnored("image location changed");
  return jobSucceeded({ thumbnail_size: thumbnailSize });
}

export function handleThumbnailJob(
  job: BackgroundJob
): Promise<BackgroundJobOutcome> {
  return withImageStorageMutationLock(job.target_id, (signal) =>
    generateThumbnailWhileLocked(job, signal)
  );
}
