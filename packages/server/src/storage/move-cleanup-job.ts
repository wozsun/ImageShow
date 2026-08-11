import { ApiError, errorMessage } from "../core/api-error.ts";
import { pool } from "../core/database-pools.ts";
import { logger } from "../core/logger.ts";
import {
  jobSucceeded,
  type BackgroundJobOutcome
} from "../jobs/handler-outcome.ts";
import type { BackgroundJob } from "../jobs/types.ts";
import { getStorageBackend } from "./backend-registry.ts";
import { thumbnailObjectKey } from "./image-paths.ts";
import { withImageStorageMutationLock } from "./maintenance-lock.ts";
import { removeStorageObjectAndConfirm } from "./object-access.ts";
import type { CapturedMoveCleanupObject } from "./move-cleanup-types.ts";
import {
  shareStorageNamespace,
  storageNamespaceIncludesIdentity
} from "./storage-namespace.ts";

function cleanupObjectsFromPayload(
  job: BackgroundJob
): CapturedMoveCleanupObject[] | null {
  if (!Array.isArray(job.payload.objects) || !job.payload.objects.length) {
    return null;
  }
  const objects: CapturedMoveCleanupObject[] = [];
  for (const candidate of job.payload.objects) {
    if (!candidate || typeof candidate !== "object") return null;
    const object = candidate as Record<string, unknown>;
    if (
      typeof object.key !== "string"
      || !object.key
      || typeof object.backend !== "string"
      || !object.backend
      || typeof object.namespace_identity !== "string"
      || !object.namespace_identity
      || !["media", "thumbs"].includes(String(object.prefix))
    ) {
      return null;
    }
    objects.push({
      prefix: object.prefix as "media" | "thumbs",
      key: object.key,
      backend: object.backend,
      namespace_identity: object.namespace_identity
    });
  }
  return objects;
}

function metadataReferencesObject(
  object: CapturedMoveCleanupObject,
  row: { object_key: string; storage_slug: string }
) {
  return object.prefix === "media"
    ? row.object_key === object.key
    : thumbnailObjectKey(row.object_key) === object.key;
}

export async function handleMoveCleanupJob(
  job: BackgroundJob,
  signal: AbortSignal
): Promise<BackgroundJobOutcome> {
  signal.throwIfAborted();
  const objects = cleanupObjectsFromPayload(job);
  if (!objects) {
    throw new ApiError(
      500,
      "storage_cleanup_payload_invalid",
      "待清理对象任务缺少完整的物理位置凭据",
      { job_id: job.id, image_id: job.target_id }
    );
  }

  return withImageStorageMutationLock(job.target_id, async (signal) => {
    const candidateBackends = new Map<
      string,
      Awaited<ReturnType<typeof getStorageBackend>>
    >();
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

    const seen = new Set<string>();
    for (const object of objects) {
      signal.throwIfAborted();
      const identity = `${object.backend}:${object.prefix}:${object.key}`;
      if (seen.has(identity)) continue;
      seen.add(identity);

      const objectBackend = await candidateBackend(object.backend);
      if (!storageNamespaceIncludesIdentity(
        objectBackend,
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

      // This query is the deletion boundary. The image mutation lock prevents
      // the same image from moving again until the decision has completed.
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
      if (latest && metadataReferencesObject(object, latest)) {
        let stillReferenced = object.backend === latest.storage_slug;
        if (!stillReferenced) {
          const latestBackend = await getStorageBackend(latest.storage_slug);
          signal.throwIfAborted();
          stillReferenced = shareStorageNamespace(
            objectBackend,
            latestBackend
          );
        }
        if (stillReferenced) continue;
      }

      try {
        await removeStorageObjectAndConfirm(
          object.prefix,
          object.key,
          object.backend,
          { signal }
        );
      } catch (error) {
        logger.warn("move_cleanup_object_delete_failed", {
          job_id: job.id,
          image_id: job.target_id,
          backend: object.backend,
          prefix: object.prefix,
          key: object.key,
          cleanup_reason: typeof job.payload.reason === "string"
            ? job.payload.reason
            : "",
          error: errorMessage(error)
        });
        throw error;
      }
      signal.throwIfAborted();
    }

    return jobSucceeded();
  });
}
