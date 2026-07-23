import { appConfig } from "@imageshow/shared";
import {
  getStorageBackend,
  resolveStorageAccess
} from "../storage/backend-registry.ts";
import { pool } from "../core/db.ts";
import { ApiError, errorMessage } from "../core/api-error.ts";
import { abortActiveImport } from "../images/imports/execution.ts";
import {
  importSessionLockKey,
  withImportSessionLock
} from "../images/imports/session-lock.ts";
import { cleanupOrphanRawImports, removeRawImport } from "../images/imports/temp-files.ts";
import {
  cleanupFinalImportObjects,
  cleanupStagedObjects
} from "../images/imports/staging.ts";
import { purgeDeletedImages } from "../images/trash.ts";
import {
  createThumbnail,
  generateStoredThumbnail,
  md5Buffer
} from "../images/processing.ts";
import { rebuildRandomPool } from "../random/cache-rebuild.ts";
import { thumbnailObjectKey } from "../storage/image-paths.ts";
import {
  tryWithStorageLocationReadAndAdvisoryLocks,
  withImageStorageMutationLock
} from "../storage/maintenance-lock.ts";
import {
  shareStorageNamespace,
  storageNamespaceIncludesIdentity
} from "../storage/storage-namespace.ts";
import {
  removeStorageObject,
  storageObjectExists
} from "../storage/object-access.ts";
import type { StoragePrefix } from "../storage/object-keys.ts";
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

  let cancelled = 0;
  for (const candidate of candidates) {
    const attempt = await tryWithStorageLocationReadAndAdvisoryLocks(
      [{ key: importSessionLockKey(candidate.id), acquisition: "try" }],
      (signal) => {
        signal.throwIfAborted();
        return pool.query(
          `UPDATE import_session
           SET status='cancelled',
               execution_token=NULL,
               raw_token=NULL,
               error='提交进程中断且会话已过期',
               updated_at=now()
           WHERE id=$1 AND status='committing' AND expires_at < now()`,
          [candidate.id]
        );
      }
    );
    if (attempt.acquired) cancelled += attempt.value.rowCount ?? 0;
  }
  return cancelled;
}

async function generateThumbnailUnlocked(
  job: BackgroundJob,
  signal: AbortSignal
): Promise<BackgroundJobOutcome> {
  signal.throwIfAborted();
  const row = (await pool.query(
    "SELECT object_key, status, storage_slug, md5 FROM metadata WHERE id=$1",
    [job.target_id]
  )).rows[0];
  signal.throwIfAborted();
  if (!row) return ignored("metadata missing");
  if (row.status !== "ready") return ignored("image not ready");
  const storage = await resolveStorageAccess(row.storage_slug);
  signal.throwIfAborted();
  if (!await storage.driver.exists("media", row.object_key)) {
    return ignored("object missing");
  }
  signal.throwIfAborted();

  let thumbnailSize: number;
  if (storage.config.type !== "local") {
    const buffer = await storage.driver.readBuffer("media", row.object_key);
    signal.throwIfAborted();
    if (row.md5 && md5Buffer(buffer) !== row.md5) {
      throw new Error(
        `integrity check failed: stored object md5 does not match recorded md5 (${row.md5})`
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
    thumbnailSize = await generateStoredThumbnail(row.object_key, row.storage_slug);
    signal.throwIfAborted();
  }

  const updated = await pool.query(
    `UPDATE metadata
        SET thumbnail_size=$2
      WHERE id=$1 AND status='ready' AND storage_slug=$3 AND object_key=$4`,
    [job.target_id, thumbnailSize, row.storage_slug, row.object_key]
  );
  signal.throwIfAborted();
  if (!updated.rowCount) return ignored("image location changed");
  return succeeded({ thumbnail_size: thumbnailSize });
}

function generateThumbnail(job: BackgroundJob): Promise<BackgroundJobOutcome> {
  return withImageStorageMutationLock(job.target_id, (signal) =>
    generateThumbnailUnlocked(job, signal)
  );
}

async function cleanupMovedObjects(job: BackgroundJob): Promise<BackgroundJobOutcome> {
  type CleanupObject = {
    prefix: StoragePrefix;
    key: string;
    backend: string;
    namespace_identity: string;
  };

  const objects: CleanupObject[] = Array.isArray(job.payload.objects)
    ? job.payload.objects.filter((candidate): candidate is {
        prefix: StoragePrefix;
        key: string;
        backend: string;
        namespace_identity: string;
      } => {
        if (!candidate || typeof candidate !== "object") return false;
        const object = candidate as Record<string, unknown>;
        return typeof object.key === "string"
          && typeof object.backend === "string"
          && typeof object.namespace_identity === "string"
          && object.namespace_identity.length > 0
          && ["media", "thumbs"].includes(String(object.prefix));
      })
    : [];
  if (!objects.length) return ignored("invalid or empty move cleanup payload");

  return withImageStorageMutationLock(job.target_id, async (signal) => {
    signal.throwIfAborted();
    const row = (await pool.query(
      `SELECT id, object_key, storage_slug
         FROM metadata
        WHERE id=$1`,
      [job.target_id]
    )).rows[0] as {
      id: string;
      object_key: string;
      storage_slug: string;
    } | undefined;
    const currentReferences = new Set<string>();
    if (row) {
      currentReferences.add(`media:${row.object_key}`);
      currentReferences.add(`thumbs:${thumbnailObjectKey(row.object_key)}`);
    }
    const currentBackend = row
      ? await getStorageBackend(row.storage_slug)
      : undefined;
    signal.throwIfAborted();
    const candidateBackends = new Map<string, Awaited<ReturnType<typeof getStorageBackend>>>();
    const candidateBackend = async (slug: string) => {
      let config = candidateBackends.get(slug);
      if (!config) {
        signal.throwIfAborted();
        config = await getStorageBackend(slug);
        signal.throwIfAborted();
        candidateBackends.set(slug, config);
      }
      return config;
    };

    let removed = 0;
    let retained = 0;
    let missing = 0;
    const seen = new Set<string>();
    for (const object of objects) {
      signal.throwIfAborted();
      const identity = `${object.backend}:${object.prefix}:${object.key}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (!storageNamespaceIncludesIdentity(
        await candidateBackend(object.backend),
        object.namespace_identity
      )) {
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
      // The earlier snapshot is only an optimization. Re-read PostgreSQL at
      // the deletion boundary so a lock-loss successor cannot make this key
      // authoritative between the first check and the irreversible remove.
      const latest = (await pool.query(
        `SELECT object_key, storage_slug
           FROM metadata
          WHERE id=$1`,
        [job.target_id]
      )).rows[0] as {
        object_key: string;
        storage_slug: string;
      } | undefined;
      signal.throwIfAborted();
      const latestMatches = latest && (
        (object.prefix === "media" && latest.object_key === object.key)
        || (
          object.prefix === "thumbs"
          && thumbnailObjectKey(latest.object_key) === object.key
        )
      );
      if (latestMatches) {
        const latestBackend = await getStorageBackend(latest.storage_slug);
        const objectBackend = await candidateBackend(object.backend);
        signal.throwIfAborted();
        if (
          object.backend === latest.storage_slug
          || shareStorageNamespace(objectBackend, latestBackend)
        ) {
          retained += 1;
          continue;
        }
      }
      if (!await storageObjectExists(object.prefix, object.key, object.backend)) {
        missing += 1;
        continue;
      }
      signal.throwIfAborted();
      await removeStorageObject(object.prefix, object.key, object.backend);
      signal.throwIfAborted();
      if (await storageObjectExists(object.prefix, object.key, object.backend)) {
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
  const cancelledCommitting = await cancelExpiredCommittingImports();
  const rows = (await pool.query(
      `WITH expired AS (
         SELECT id
         FROM import_session
         WHERE status IN (
           'created','materializing','received','preparing','ready',
           'finalized','failed','cancelled'
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
           execution_token=NULL,
           raw_token=NULL,
           updated_at=now()
       FROM expired
       WHERE session.id=expired.id
       RETURNING session.id`,
    [appConfig.trashBatchSize]
  )).rows as Array<{ id: string }>;

  const cleanedIds: string[] = [];
  const failures: string[] = [];
  for (const row of rows) {
    try {
      await abortActiveImport(row.id);
      await withImportSessionLock(row.id, async (signal) => {
        signal.throwIfAborted();
        const session = (await pool.query(
          `SELECT status, storage_slug, final_object_key
             FROM import_session
            WHERE id=$1`,
          [row.id]
        )).rows[0] as {
          status: string;
          storage_slug: string;
          final_object_key: string;
        } | undefined;
        if (!session || !["cancelled", "finalized"].includes(session.status)) return;
        signal.throwIfAborted();
        const cleanups = await Promise.allSettled([
          cleanupStagedObjects(row.id, session.storage_slug),
          cleanupFinalImportObjects(
            row.id,
            session.final_object_key,
            session.storage_slug
          ),
          removeRawImport(row.id)
        ]);
        const failures = cleanups
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason);
        if (failures.length) {
          throw new AggregateError(failures, "Expired import cleanup failed");
        }
        signal.throwIfAborted();
        cleanedIds.push(row.id);
      });
    } catch (error) {
      failures.push(`${row.id}: ${errorMessage(error)}`);
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
