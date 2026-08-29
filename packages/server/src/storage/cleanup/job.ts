import { ApiError, errorMessage } from "../../core/api-error.ts";
import { pool } from "../../core/database/pools.ts";
import { logger } from "../../core/logger.ts";
import {
  jobRescheduled,
  jobSucceeded,
  type BackgroundJobOutcome
} from "../../jobs/handler-outcome.ts";
import type { BackgroundJob } from "../../jobs/types.ts";
import { getStorageBackend } from "../backends/registry.ts";
import { thumbnailObjectKey } from "../objects/image-paths.ts";
import { withImageStorageMutationLock } from "../maintenance-lock.ts";
import {
  assertStorageRemovalResults,
  removeStorageObjectsAndConfirm,
  type StorageRemovalRequest
} from "../objects/access.ts";
import type { CapturedMoveCleanupObject } from "./types.ts";
import { readRunningMoveCleanupJobPayload } from "./repository.ts";
import {
  shareStorageNamespace,
  storageNamespaceIncludesIdentity
} from "../objects/namespace.ts";

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

function cleanupConfirmationDelay(job: BackgroundJob) {
  const value = job.payload.confirm_absent_after;
  if (value === undefined) return 0;
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - Date.now());
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
  scheduleSignal: AbortSignal
): Promise<BackgroundJobOutcome> {
  scheduleSignal.throwIfAborted();
  const objects = cleanupObjectsFromPayload(job);
  const confirmationDelay = cleanupConfirmationDelay(job);
  if (!objects || confirmationDelay === null) {
    throw new ApiError(
      500,
      "storage_cleanup_payload_invalid",
      "待清理对象任务缺少完整的物理位置凭据",
      { job_id: job.id, image_id: job.target_id }
    );
  }
  const ingestionCandidateGuard =
    job.payload.reason === "ingestion_commit_candidate_guard";
  if (confirmationDelay > 0 && !ingestionCandidateGuard) {
    return jobRescheduled(confirmationDelay);
  }

  return withImageStorageMutationLock(job.target_id, async (lockSignal) => {
    const admissionSignal = AbortSignal.any([scheduleSignal, lockSignal]);
    let lockedJob = job;
    let lockedObjects = objects;
    if (ingestionCandidateGuard) {
      admissionSignal.throwIfAborted();
      const payload = await readRunningMoveCleanupJobPayload(
        job.id,
        job.execution_token
      );
      admissionSignal.throwIfAborted();
      if (!payload) {
        throw new ApiError(
          409,
          "storage_cleanup_execution_lost",
          "待清理对象任务已经失去当前执行权",
          { job_id: job.id, image_id: job.target_id }
        );
      }
      lockedJob = { ...job, payload };
      const refreshedObjects = cleanupObjectsFromPayload(lockedJob);
      const refreshedDelay = cleanupConfirmationDelay(lockedJob);
      if (!refreshedObjects || refreshedDelay === null) {
        throw new ApiError(
          500,
          "storage_cleanup_payload_invalid",
          "待清理对象任务缺少完整的物理位置凭据",
          { job_id: job.id, image_id: job.target_id }
        );
      }
      if (refreshedDelay > 0) return jobRescheduled(refreshedDelay);
      lockedObjects = refreshedObjects;
    }
    const candidateBackends = new Map<
      string,
      Awaited<ReturnType<typeof getStorageBackend>>
    >();
    const candidateBackend = async (slug: string) => {
      let config = candidateBackends.get(slug);
      if (!config) {
        admissionSignal.throwIfAborted();
        config = await getStorageBackend(slug);
        admissionSignal.throwIfAborted();
        candidateBackends.set(slug, config);
      }
      return config;
    };

    admissionSignal.throwIfAborted();
    // This locked read is the deletion boundary: every payload object is
    // compared with the same latest metadata snapshot before one batch starts.
    const latest = (await pool.query(
      `SELECT object_key, storage_slug
         FROM metadata
        WHERE id=$1`,
      [job.target_id]
    )).rows[0] as {
      object_key: string;
      storage_slug: string;
    } | undefined;
    admissionSignal.throwIfAborted();

    const seen = new Set<string>();
    const removals: StorageRemovalRequest[] = [];
    for (const object of lockedObjects) {
      admissionSignal.throwIfAborted();
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

      if (latest && metadataReferencesObject(object, latest)) {
        let stillReferenced = object.backend === latest.storage_slug;
        if (!stillReferenced) {
          const latestBackend = await getStorageBackend(latest.storage_slug);
          admissionSignal.throwIfAborted();
          stillReferenced = shareStorageNamespace(
            objectBackend,
            latestBackend
          );
        }
        if (stillReferenced) continue;
      }
      removals.push({
        prefix: object.prefix,
        key: object.key,
        storageSlug: object.backend
      });
    }

    if (removals.length) {
      try {
        const results = await removeStorageObjectsAndConfirm(removals, {
          signal: lockSignal
        }, admissionSignal);
        assertStorageRemovalResults(
          results,
          "持久存储清理任务未能确认全部对象删除"
        );
      } catch (error) {
        logger.warn("move_cleanup_object_delete_failed", {
          job_id: job.id,
          image_id: job.target_id,
          objects: removals.length,
          cleanup_reason: typeof lockedJob.payload.reason === "string"
            ? lockedJob.payload.reason
            : "",
          error: errorMessage(error)
        });
        throw error;
      }
      lockSignal.throwIfAborted();
    }

    return jobSucceeded();
  });
}
