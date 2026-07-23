import { ApiError, errorMessage } from "../core/api-error.ts";
import { pool } from "../core/db.ts";
import { logger } from "../core/logger.ts";
import {
  jobSucceeded,
  type BackgroundJobOutcome
} from "../jobs/handler-outcome.ts";
import type { BackgroundJob } from "../jobs/types.ts";
import { getStorageBackend } from "./backend-registry.ts";
import { thumbnailObjectKey } from "./image-paths.ts";
import { withImageStorageMutationLock } from "./maintenance-lock.ts";
import {
  pruneEmptyStorageDirs,
  removeStorageObjectAndConfirm
} from "./object-access.ts";
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
    objects.push(object as CapturedMoveCleanupObject);
  }
  return objects;
}

export async function handleMoveCleanupJob(
  job: BackgroundJob
): Promise<BackgroundJobOutcome> {
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
      currentReferences.add(
        `thumbs:${thumbnailObjectKey(row.object_key)}`
      );
    }
    const currentBackend = row
      ? await getStorageBackend(row.storage_slug)
      : undefined;
    signal.throwIfAborted();
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

      // Re-read PostgreSQL at the irreversible deletion boundary. The first
      // snapshot is only an optimization and never authorizes deletion.
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
      let removal: "missing" | "removed";
      try {
        removal = await removeStorageObjectAndConfirm(
          object.prefix,
          object.key,
          object.backend
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
      if (removal === "missing") {
        missing += 1;
        continue;
      }
      removed += 1;
    }
    for (const backend of new Set(objects.map((object) => object.backend))) {
      signal.throwIfAborted();
      await pruneEmptyStorageDirs(backend);
    }
    signal.throwIfAborted();
    return jobSucceeded({ removed, retained, missing });
  });
}
