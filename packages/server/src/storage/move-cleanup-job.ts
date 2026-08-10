import { createHash } from "node:crypto";
import { ApiError, errorMessage } from "../core/api-error.ts";
import { pool } from "../core/db.ts";
import { logger } from "../core/logger.ts";
import {
  jobRescheduled,
  jobSucceeded,
  type BackgroundJobOutcome
} from "../jobs/handler-outcome.ts";
import { backgroundJobExecutionIsCurrent } from "../jobs/repository.ts";
import type { BackgroundJob } from "../jobs/types.ts";
import {
  getStorageBackend,
  resolveStorageAccessForConfig
} from "./backend-registry.ts";
import { thumbnailObjectKey } from "./image-paths.ts";
import { withImageStorageMutationLock } from "./maintenance-lock.ts";
import {
  pruneEmptyStorageDirs,
  removeStorageObjectAndConfirm
} from "./object-access.ts";
import {
  digestStorageObject,
  ensureVerifiedObjectAtTarget
} from "./object-transfer.ts";
import type { CapturedMoveCleanupObject } from "./move-cleanup-types.ts";
import {
  thumbnailObjectHasPendingRepair,
  type ThumbnailRepairCleanupAuthorization
} from "./move-cleanup.ts";
import { markThumbnailRepairSettled } from "./thumbnail-repair-state.ts";
import {
  shareStorageNamespace,
  storageNamespaceIncludesIdentity
} from "./storage-namespace.ts";

function cleanupObjectsFromPayload(
  job: BackgroundJob
): {
  objects: CapturedMoveCleanupObject[];
  thumbnailRepairBody: Buffer | null;
} | null {
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
    const repair = object.thumbnail_repair;
    if (
      repair !== undefined
      && (
        object.prefix !== "thumbs"
        || !repair
        || typeof repair !== "object"
        || typeof (repair as Record<string, unknown>).expected_sha256 !== "string"
        || !/^[a-f0-9]{64}$/.test(
          String((repair as Record<string, unknown>).expected_sha256)
        )
        || !Number.isSafeInteger(
          (repair as Record<string, unknown>).expected_size
        )
        || Number((repair as Record<string, unknown>).expected_size) < 0
      )
    ) {
      return null;
    }
    objects.push(object as CapturedMoveCleanupObject);
  }
  const repairs = objects.filter((object) => object.thumbnail_repair);
  const encodedBody = job.payload.thumbnail_repair_body_base64;
  if (!repairs.length) {
    return encodedBody === undefined
      ? { objects, thumbnailRepairBody: null }
      : null;
  }
  if (
    repairs.length !== 1
    || objects.length !== 1
    || typeof encodedBody !== "string"
    || !encodedBody
  ) {
    return null;
  }
  const body = Buffer.from(encodedBody, "base64");
  const repair = repairs[0]!.thumbnail_repair!;
  if (
    body.toString("base64") !== encodedBody
    || body.byteLength !== repair.expected_size
    || createHash("sha256").update(body).digest("hex")
      !== repair.expected_sha256
  ) {
    return null;
  }
  return { objects, thumbnailRepairBody: body };
}

export async function handleMoveCleanupJob(
  job: BackgroundJob,
  signal: AbortSignal
): Promise<BackgroundJobOutcome> {
  signal.throwIfAborted();
  const payload = cleanupObjectsFromPayload(job);
  if (!payload) {
    throw new ApiError(
      500,
      "storage_cleanup_payload_invalid",
      "待清理对象任务缺少完整的物理位置凭据",
      { job_id: job.id, image_id: job.target_id }
    );
  }
  const { objects, thumbnailRepairBody } = payload;
  const thumbnailRepairObject = objects.find(
    (object) => object.thumbnail_repair
  );

  return withImageStorageMutationLock(job.target_id, async (signal) => {
    signal.throwIfAborted();
    if (
      thumbnailRepairObject
      && !await backgroundJobExecutionIsCurrent(job)
    ) {
      return jobSucceeded();
    }
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
      if (
        matchesCurrentObject
        && sharesCurrentNamespace
        && !object.thumbnail_repair
      ) {
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
          if (object.prefix === "thumbs" && object.thumbnail_repair) {
            const endpoint = resolveStorageAccessForConfig(objectBackend);
            const candidateExists = await endpoint.driver.exists(
              object.prefix,
              object.key,
              { signal }
            );
            signal.throwIfAborted();
            if (!candidateExists) {
              if (!thumbnailRepairBody) {
                throw new ApiError(
                  500,
                  "thumbnail_repair_payload_invalid",
                  "缩略图修复任务缺少可重试的权威字节"
                );
              }
              const authorization: ThumbnailRepairCleanupAuthorization = {
                receiptId: job.id,
                imageId: job.target_id,
                object: object as ThumbnailRepairCleanupAuthorization["object"]
              };
              await ensureVerifiedObjectAtTarget({
                target: endpoint,
                prefix: "thumbs",
                key: object.key,
                body: thumbnailRepairBody,
                contentType: "image/webp",
                repairAuthorization: authorization,
                signal
              });
              signal.throwIfAborted();
            }
            let digest = await digestStorageObject(
              endpoint,
              object.prefix,
              object.key,
              { signal }
            );
            signal.throwIfAborted();
            if (
              digest.size !== object.thumbnail_repair.expected_size
              || digest.sha256 !== object.thumbnail_repair.expected_sha256
            ) {
              if (!thumbnailRepairBody) {
                throw new ApiError(
                  500,
                  "thumbnail_repair_payload_invalid",
                  "缩略图修复任务缺少可重试的权威字节"
                );
              }
              await removeStorageObjectAndConfirm(
                object.prefix,
                object.key,
                object.backend,
                { signal }
              );
              signal.throwIfAborted();
              const authorization: ThumbnailRepairCleanupAuthorization = {
                receiptId: job.id,
                imageId: job.target_id,
                object: object as ThumbnailRepairCleanupAuthorization["object"]
              };
              await ensureVerifiedObjectAtTarget({
                target: endpoint,
                prefix: "thumbs",
                key: object.key,
                body: thumbnailRepairBody,
                contentType: "image/webp",
                repairAuthorization: authorization,
                signal
              });
              signal.throwIfAborted();
              digest = await digestStorageObject(
                endpoint,
                object.prefix,
                object.key,
                { signal }
              );
              signal.throwIfAborted();
              if (
                digest.size !== object.thumbnail_repair.expected_size
                || digest.sha256 !== object.thumbnail_repair.expected_sha256
              ) {
                throw new ApiError(
                  502,
                  "thumbnail_repair_integrity_failed",
                  "缩略图修复重试后仍未得到预期内容"
                );
              }
            }
            const adopted = await pool.query(
              `UPDATE metadata
                  SET thumbnail_size=$2
                WHERE id=$1
                  AND storage_slug=$3
                  AND object_key=$4`,
              [
                job.target_id,
                digest.size,
                latest.storage_slug,
                latest.object_key
              ]
            );
            signal.throwIfAborted();
            if (!adopted.rowCount) {
              throw new ApiError(
                409,
                "thumbnail_repair_ownership_changed",
                "缩略图修复候选的数据库归属已经变化"
              );
            }
            continue;
          }
          continue;
        }
      }
      if (object.prefix === "thumbs" && !object.thumbnail_repair) {
        const objectBackend = await candidateBackend(object.backend);
        signal.throwIfAborted();
        if (await thumbnailObjectHasPendingRepair(
          objectBackend,
          object.key,
          job.id
        )) {
          return jobRescheduled(1_000);
        }
        signal.throwIfAborted();
      }
      try {
        const removal = await removeStorageObjectAndConfirm(
          object.prefix,
          object.key,
          object.backend,
          { signal }
        );
        if (object.thumbnail_repair && removal === "missing") {
          throw new ApiError(
            503,
            "thumbnail_repair_candidate_unsettled",
            "迟到缩略图写入尚未出现，保留修复回执等待后续核验"
          );
        }
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
    for (const backend of new Set(objects.map((object) => object.backend))) {
      signal.throwIfAborted();
      await pruneEmptyStorageDirs(backend, { signal });
    }
    signal.throwIfAborted();
    if (thumbnailRepairObject) {
      markThumbnailRepairSettled(job.target_id, thumbnailRepairObject.key);
    }
    return jobSucceeded();
  });
}
