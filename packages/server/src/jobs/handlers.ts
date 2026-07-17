import { appConfig } from "@imageshow/shared";
import { getStorageBackend } from "../storage/backend-registry.ts";
import { pool } from "../core/db.ts";
import { errorMessage } from "../core/http.ts";
import { importCommitLockKey } from "../images/imports/execution.ts";
import { cleanupOrphanRawImports, removeRawImport } from "../images/imports/temp-files.ts";
import { stagingImageKey, stagingThumbnailKey } from "../images/imports/staging.ts";
import {
  createThumbnail,
  generateStoredThumbnail,
  md5Buffer
} from "../images/processing.ts";
import { rebuildRandomPool } from "../random/random-cache.ts";
import { thumbnailObjectKey } from "../storage/image-paths.ts";
import {
  exists,
  readStorageBuffer,
  removeObject,
  writeStorageBuffer
} from "../storage/storage.ts";
import type { BackgroundJob } from "./repository.ts";

export type BackgroundJobOutcome =
  | { status: "succeeded"; result?: unknown }
  | { status: "ignored"; reason: string };

function succeeded(result?: unknown): BackgroundJobOutcome {
  return { status: "succeeded", result };
}

function ignored(reason: string): BackgroundJobOutcome {
  return { status: "ignored", reason };
}

async function cancelExpiredCommittingImports() {
  const candidates = (await pool.query(
    `SELECT id
     FROM import_session
     WHERE status='committing' AND expires_at < now()
     ORDER BY expires_at ASC
     LIMIT $1`,
    [appConfig.trashBatchSize]
  )).rows as Array<{ id: string }>;
  if (!candidates.length) return 0;

  const client = await pool.connect();
  let cancelled = 0;
  try {
    for (const candidate of candidates) {
      const lockKey = importCommitLockKey(candidate.id);
      const locked = Boolean((await client.query(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
        [lockKey]
      )).rows[0]?.locked);
      if (!locked) continue;

      try {
        const result = await client.query(
          `UPDATE import_session
           SET status='cancelled',
               error='提交进程中断且会话已过期',
               updated_at=now()
           WHERE id=$1 AND status='committing' AND expires_at < now()`,
          [candidate.id]
        );
        cancelled += result.rowCount ?? 0;
      } finally {
        await client.query(
          "SELECT pg_advisory_unlock(hashtext($1))",
          [lockKey]
        ).catch(() => undefined);
      }
    }
  } finally {
    client.release();
  }
  return cancelled;
}

async function generateThumbnail(job: BackgroundJob): Promise<BackgroundJobOutcome> {
  const row = (await pool.query(
    "SELECT object_key, status, storage_slug, is_link, md5 FROM metadata WHERE id=$1",
    [job.target_id]
  )).rows[0];
  if (!row) return ignored("metadata missing");
  if (row.status !== "ready") return ignored("image not ready");
  if (row.is_link) return ignored("link thumbnail generated at import");
  if (!await exists("media", row.object_key, row.storage_slug)) {
    return ignored("object missing");
  }

  let thumbnailSize: number;
  const config = await getStorageBackend(row.storage_slug);
  if (config.type !== "local") {
    const buffer = await readStorageBuffer("media", row.object_key, row.storage_slug);
    if (row.md5 && md5Buffer(buffer) !== row.md5) {
      throw new Error(
        `integrity check failed: stored object md5 does not match recorded md5 (${row.md5})`
      );
    }
    const thumbnail = await createThumbnail(buffer);
    await writeStorageBuffer(
      "thumbs",
      thumbnailObjectKey(row.object_key),
      thumbnail,
      "image/webp",
      row.storage_slug
    );
    thumbnailSize = thumbnail.byteLength;
  } else {
    thumbnailSize = await generateStoredThumbnail(row.object_key, row.storage_slug);
  }

  await pool.query(
    "UPDATE metadata SET thumbnail_size=$2 WHERE id=$1",
    [job.target_id, thumbnailSize]
  );
  return succeeded({ thumbnail_size: thumbnailSize });
}

async function cleanupMovedObjects(job: BackgroundJob): Promise<BackgroundJobOutcome> {
  const objectKey = typeof job.payload.object_key === "string"
    ? job.payload.object_key
    : "";
  const backend = typeof job.payload.backend === "string"
    ? job.payload.backend
    : undefined;
  if (objectKey) {
    await removeObject("media", objectKey, backend);
    await removeObject("thumbs", thumbnailObjectKey(objectKey), backend);
  }
  return succeeded();
}

async function cleanupExpiredImports(): Promise<BackgroundJobOutcome> {
  const cancelledCommitting = await cancelExpiredCommittingImports();
  const rows = (await pool.query(
    `WITH expired AS (
       SELECT id
       FROM import_session
       WHERE status IN ('created','receiving','preparing','ready','failed','cancelled')
         AND expires_at < now()
       ORDER BY expires_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE import_session AS session
     SET status='cancelled', updated_at=now()
     FROM expired
     WHERE session.id=expired.id
     RETURNING session.id, session.storage_slug`,
    [appConfig.trashBatchSize]
  )).rows as Array<{ id: string; storage_slug: string }>;

  const cleanedIds: string[] = [];
  const failures: string[] = [];
  for (const row of rows) {
    try {
      await Promise.all([
        removeObject("_uploads", stagingImageKey(row.id), row.storage_slug),
        removeObject("_uploads", stagingThumbnailKey(row.id), row.storage_slug),
        removeRawImport(row.id)
      ]);
      cleanedIds.push(row.id);
    } catch (error) {
      failures.push(`${row.storage_slug}/${row.id}: ${errorMessage(error)}`);
    }
  }

  const deletedExpired = await pool.query(
    "DELETE FROM import_session WHERE id = ANY($1::uuid[]) AND status='cancelled'",
    [cleanedIds]
  );
  const deletedFinalized = await pool.query(
    "DELETE FROM import_session WHERE status='finalized' AND expires_at < now()"
  );
  await cleanupOrphanRawImports(appConfig.uploadTtlSeconds * 1000);

  if (failures.length) {
    throw new Error(`import staging cleanup failed: ${failures.join("; ")}`);
  }
  return succeeded({
    cleaned: (deletedExpired.rowCount ?? 0) + (deletedFinalized.rowCount ?? 0),
    cancelled_committing: cancelledCommitting
  });
}

export async function handleBackgroundJob(
  job: BackgroundJob
): Promise<BackgroundJobOutcome> {
  switch (job.type) {
    case "thumb.generate":
      return generateThumbnail(job);
    case "move.cleanup":
      return cleanupMovedObjects(job);
    case "import.cleanup":
      return cleanupExpiredImports();
    case "cache.rebuild":
      await rebuildRandomPool();
      return succeeded();
    default:
      return ignored("not implemented");
  }
}
