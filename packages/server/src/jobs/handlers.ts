import { appConfig } from "@imageshow/shared";
import { getStorageBackend } from "../storage/backend-registry.ts";
import { pool } from "../core/db.ts";
import { ApiError, errorMessage } from "../core/api-error.ts";
import { importCommitLockKey } from "../images/imports/execution.ts";
import { cleanupOrphanRawImports, removeRawImport } from "../images/imports/temp-files.ts";
import { cleanupStagedObjects } from "../images/imports/staging.ts";
import { purgeDeletedImages } from "../images/trash.ts";
import {
  createThumbnail,
  generateStoredThumbnail,
  md5Buffer
} from "../images/processing.ts";
import { rebuildRandomPool } from "../random/random-cache.ts";
import { thumbnailObjectKey, thumbnailRef } from "../storage/image-paths.ts";
import {
  withImageStorageMutationLock,
  withStorageLocationReadLock
} from "../storage/maintenance-lock.ts";
import {
  shareStorageNamespace,
  storageNamespaceIdentity
} from "../storage/storage-namespace.ts";
import {
  exists,
  readStorageBuffer,
  removeObject,
  type StoragePrefix,
  writeStorageBuffer
} from "../storage/storage.ts";
import type { BackgroundJob } from "./repository.ts";

export type BackgroundJobOutcome =
  | { status: "succeeded"; result?: unknown }
  | { status: "ignored"; reason: string }
  | { status: "reschedule"; delayMs: number; result?: unknown };

function succeeded(result?: unknown): BackgroundJobOutcome {
  return { status: "succeeded", result };
}

function ignored(reason: string): BackgroundJobOutcome {
  return { status: "ignored", reason };
}

async function purgeTrashBatch(): Promise<BackgroundJobOutcome> {
  const result = await purgeDeletedImages();
  if (result.failed) {
    throw new Error(
      `trash purge batch failed for ${result.failed} of ${result.requested} claimed images`
    );
  }
  if (result.remaining) {
    return {
      status: "reschedule",
      delayMs: result.requested ? 0 : 1_000,
      result
    };
  }
  return succeeded(result);
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

async function generateThumbnailUnlocked(
  job: BackgroundJob
): Promise<BackgroundJobOutcome> {
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

function generateThumbnail(job: BackgroundJob): Promise<BackgroundJobOutcome> {
  return withImageStorageMutationLock(job.target_id, () =>
    generateThumbnailUnlocked(job)
  );
}

async function cleanupMovedObjects(job: BackgroundJob): Promise<BackgroundJobOutcome> {
  type CleanupObject = {
    prefix: StoragePrefix;
    key: string;
    backend: string;
    namespace_identity?: string;
  };

  const objects: CleanupObject[] = Array.isArray(job.payload.objects)
    ? job.payload.objects.filter((candidate): candidate is {
        prefix: StoragePrefix;
        key: string;
        backend: string;
        namespace_identity?: string;
      } => {
        if (!candidate || typeof candidate !== "object") return false;
        const object = candidate as Record<string, unknown>;
        return typeof object.key === "string"
          && typeof object.backend === "string"
          && (object.namespace_identity === undefined
            || typeof object.namespace_identity === "string")
          && ["media", "thumbs", "link"].includes(String(object.prefix));
      })
    : [];

  const objectKey = typeof job.payload.object_key === "string"
    ? job.payload.object_key
    : "";
  const backend = typeof job.payload.backend === "string"
    ? job.payload.backend
    : "";
  if (!objects.length && objectKey && backend) {
    objects.push(
      { prefix: "media", key: objectKey, backend },
      { prefix: "thumbs", key: thumbnailObjectKey(objectKey), backend }
    );
  }
  if (!objects.length) return ignored("invalid or empty move cleanup payload");

  return withImageStorageMutationLock(job.target_id, async () => {
    const row = (await pool.query(
      `SELECT id, object_key, storage_slug, is_link, device, brightness, theme
         FROM metadata
        WHERE id=$1`,
      [job.target_id]
    )).rows[0] as {
      id: string;
      object_key: string;
      storage_slug: string;
      is_link: boolean;
      device: string;
      brightness: string;
      theme: string;
    } | undefined;
    const currentReferences = new Set<string>();
    if (row?.is_link) {
      const thumb = thumbnailRef(row);
      currentReferences.add(`${thumb.prefix}:${thumb.key}`);
    } else if (row) {
      currentReferences.add(`media:${row.object_key}`);
      currentReferences.add(`thumbs:${thumbnailObjectKey(row.object_key)}`);
    }
    const currentBackend = row
      ? await getStorageBackend(row.storage_slug)
      : undefined;
    const candidateBackends = new Map<string, Awaited<ReturnType<typeof getStorageBackend>>>();
    const candidateBackend = async (slug: string) => {
      let config = candidateBackends.get(slug);
      if (!config) {
        config = await getStorageBackend(slug);
        candidateBackends.set(slug, config);
      }
      return config;
    };

    let removed = 0;
    let retained = 0;
    let missing = 0;
    const seen = new Set<string>();
    for (const object of objects) {
      const identity = `${object.backend}:${object.prefix}:${object.key}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (object.namespace_identity) {
        const currentIdentity = storageNamespaceIdentity(
          await candidateBackend(object.backend)
        );
        if (currentIdentity !== object.namespace_identity) {
          throw new ApiError(
            409,
            "storage_cleanup_namespace_changed",
            "待清理对象所属的物理存储位置已经变化，已停止删除",
            {
              backend: object.backend,
              prefix: object.prefix,
              key: object.key
            }
          );
        }
      }
      const matchesCurrentObject = currentReferences.has(
        `${object.prefix}:${object.key}`
      );
      let sharesCurrentNamespace = object.backend === row?.storage_slug;
      if (matchesCurrentObject && currentBackend && !sharesCurrentNamespace) {
        sharesCurrentNamespace = shareStorageNamespace(
          await candidateBackend(object.backend),
          currentBackend
        );
      }
      if (matchesCurrentObject && sharesCurrentNamespace) {
        retained += 1;
        continue;
      }
      if (!await exists(object.prefix, object.key, object.backend)) {
        missing += 1;
        continue;
      }
      await removeObject(object.prefix, object.key, object.backend);
      if (await exists(object.prefix, object.key, object.backend)) {
        throw new ApiError(
          502,
          "storage_cleanup_incomplete",
          "存储后端未确认待清理对象已经删除",
          {
            backend: object.backend,
            prefix: object.prefix,
            key: object.key
          }
        );
      }
      removed += 1;
    }
    return succeeded({ removed, retained, missing });
  });
}

async function cleanupExpiredImports(): Promise<BackgroundJobOutcome> {
  return withStorageLocationReadLock(async () => {
    const cancelledCommitting = await cancelExpiredCommittingImports();
    const rows = (await pool.query(
      `WITH expired AS (
         SELECT id
         FROM import_session
         WHERE status IN (
           'created','receiving','preparing','ready','finalized','failed','cancelled'
         )
           AND expires_at < now()
         ORDER BY expires_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE import_session AS session
       SET status=CASE
             WHEN session.status='finalized' THEN 'finalized'
             ELSE 'cancelled'
           END,
           updated_at=now()
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
          cleanupStagedObjects(row.id, row.storage_slug),
          removeRawImport(row.id)
        ]);
        cleanedIds.push(row.id);
      } catch (error) {
        failures.push(`${row.storage_slug}/${row.id}: ${errorMessage(error)}`);
      }
    }

    const deletedExpired = await pool.query(
      `DELETE FROM import_session
       WHERE id = ANY($1::uuid[])
         AND status IN ('cancelled','finalized')`,
      [cleanedIds]
    );
    await cleanupOrphanRawImports(appConfig.uploadTtlSeconds * 1000);

    if (failures.length) {
      throw new Error(`import staging cleanup failed: ${failures.join("; ")}`);
    }
    return succeeded({
      cleaned: deletedExpired.rowCount ?? 0,
      cancelled_committing: cancelledCommitting
    });
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
    case "trash.purge":
      return purgeTrashBatch();
    case "cache.rebuild":
      await rebuildRandomPool();
      return succeeded();
    default:
      return ignored("not implemented");
  }
}
