import { getIngestionMaxLongEdge } from "../../../config/app-settings.ts";
import { getRuntimeConfig } from "../../../config/runtime-config-store.ts";
import { ApiError, errorMessage } from "../../../core/api-error.ts";
import {
  runWithAdvisoryLockAcquisitionSignal
} from "../../../core/database/advisory-locks.ts";
import { logger } from "../../../core/logger.ts";
import { randomUuidV7 } from "../../../core/uuid.ts";
import { assertStorageWriteTarget } from "../../../storage/backends/registry.ts";
import { withStorageLocationReadLock } from "../../../storage/maintenance-lock.ts";
import {
  assertStorageRemovalResults,
  removeStorageObjectsAndConfirm,
  writeStorageBuffer
} from "../../../storage/objects/access.ts";
import { contentType } from "../../../storage/objects/keys.ts";
import { detectBrightness } from "../../brightness.ts";
import { deviceFromDimensions } from "../../classification.ts";
import { withNormalizationAdmission } from "../../normalization-admission.ts";
import {
  sha256Buffer,
  transcodeStoredImage
} from "../../processing.ts";
import { captureIngestionDuplicateCheck } from "../commit/duplicate-confirmation.ts";
import { ingestionCleanupRetryQueue } from "../cleanup/retry-queue.ts";
import {
  mutateIngestionExecution,
  refreshIngestionExecutionSession,
  updateIngestionExecutionProgress
} from "../execution/session.ts";
import {
  removeOwnedIngestionRaw,
} from "../raw/files.ts";
import { withActiveIngestionRawPaths } from "../raw/lease-registry.ts";
import { ingestionRawPath } from "../raw/paths.ts";
import type {
  IngestionSessionSnapshot,
  StoredIngestionSession
} from "../sessions/model.ts";
import { ingestionSessionSemanticHash } from "../sessions/projection.ts";
import { IngestionSessionRepository } from "../repository.ts";
import {
  ingestionStagingImageKey,
  ingestionStagingThumbnailKey
} from "../staging-keys.ts";
import { withIngestionPreparationAdmission } from "./preparation-admission.ts";

function requiredDeviceFromDimensions(width: number, height: number) {
  return deviceFromDimensions(width, height) ?? "pc";
}

async function currentPreparingSession(
  repository: IngestionSessionRepository,
  expected: IngestionSessionSnapshot
) {
  return refreshIngestionExecutionSession(repository, expected);
}

export function preparedAttemptIsReferenced(
  current: StoredIngestionSession | null,
  expected: Pick<IngestionSessionSnapshot, "image_id">,
  imageKey: string,
  thumbnailKey: string
) {
  return Boolean(
    current
    && current.image_id === expected.image_id
    && "prepared" in current
    && current.prepared?.prepared_image_key === imageKey
    && current.prepared.prepared_thumbnail_key === thumbnailKey
  );
}

async function cleanupPreparedAttempt(
  repository: IngestionSessionRepository,
  session: IngestionSessionSnapshot,
  storageSlug: string,
  imageKey: string,
  thumbnailKey: string
) {
  const removeIfUnreferenced = async () => {
    const current = await repository.readSession(session.owner, session.session_id);
    // A semantic publish can succeed even when its response is lost. Preserve
    // the exact objects referenced by the canonical snapshot.
    if (preparedAttemptIsReferenced(
      current,
      session,
      imageKey,
      thumbnailKey
    )) return;
    await withStorageLocationReadLock(async (signal) => {
      const results = await removeStorageObjectsAndConfirm([
        { prefix: "_uploads", key: imageKey, storageSlug },
        { prefix: "_uploads", key: thumbnailKey, storageSlug }
      ], { signal });
      assertStorageRemovalResults(
        results,
        "Prepared Ingestion attempt cleanup failed"
      );
    });
  };
  try {
    await removeIfUnreferenced();
    return;
  } catch (error) {
    logger.warn("ingestion_prepared_attempt_cleanup_deferred", {
      session_id: session.session_id,
      image_id: session.image_id,
      storage_slug: storageSlug,
      error: errorMessage(error)
    });
  }
  // The retry re-reads Redis before every delete attempt. Unknown ownership
  // therefore remains fail-closed without losing the exact staging keys.
  await ingestionCleanupRetryQueue.enqueue(removeIfUnreferenced);
}

export async function prepareIngestionSessionSnapshot(
  repository: IngestionSessionRepository,
  session: IngestionSessionSnapshot,
  signal: AbortSignal,
  dependencies: Readonly<{
    transcode?: typeof transcodeStoredImage;
    onNormalizationAdmitted?: () => void;
  }> = {}
) {
  if (
    session.status !== "preparing"
    || !session.execution_token
    || !session.raw_generation
  ) {
    throw new ApiError(409, "invalid_ingestion_state", "内容接入任务不能进入处理阶段");
  }
  const preparedGeneration = randomUuidV7();
  const keyInput = {
    session_id: session.session_id,
    image_id: session.image_id,
    generation: preparedGeneration,
    execution_token: session.execution_token
  };
  const preparedImageKey = ingestionStagingImageKey(keyInput);
  const preparedThumbnailKey = ingestionStagingThumbnailKey(keyInput);
  const rawPath = ingestionRawPath(
    session.queue,
    session,
    session.raw_generation
  );
  const transcode = dependencies.transcode ?? transcodeStoredImage;
  let enteredStorageBoundary = false;

  const prepareAndPublish = async () => {
    const runtime = getRuntimeConfig();
    let current = session;
    const normalizedState = await withNormalizationAdmission(signal, async () => {
      current = await updateIngestionExecutionProgress(
        repository,
        current,
        {
          phase: "normalizing",
          message: "校验格式、压缩原图并生成缩略图",
          progress: null
        }
      );
      dependencies.onNormalizationAdmitted?.();
      const normalized = await transcode(
        rawPath,
        {
          ...runtime.normalize,
          max_long_edge: Math.min(
            runtime.normalize.max_long_edge,
            getIngestionMaxLongEdge()
          )
        }
      );
      signal.throwIfAborted();
      current = await currentPreparingSession(repository, current);
      current = await updateIngestionExecutionProgress(
        repository,
        current,
        {
          phase: "detecting",
          message: "确认图片尺寸、设备类型和明暗",
          progress: null
        }
      );
      const detectedDevice = requiredDeviceFromDimensions(
        normalized.width,
        normalized.height
      );
      const detectedBrightness = await detectBrightness(normalized.thumbnail);
      signal.throwIfAborted();
      current = await currentPreparingSession(repository, current);
      return { normalized, detectedDevice, detectedBrightness };
    });
    const { normalized, detectedDevice, detectedBrightness } = normalizedState;
    current = await updateIngestionExecutionProgress(
      repository,
      current,
      {
        phase: "staging",
        message: "写入处理后的图片和缩略图",
        progress: null
      }
    );
    return withStorageLocationReadLock(async (lockSignal) => {
      const storageSignal = AbortSignal.any([signal, lockSignal]);
      storageSignal.throwIfAborted();
      await assertStorageWriteTarget(session.storage_slug);
      storageSignal.throwIfAborted();
      enteredStorageBoundary = true;
      const writes = await Promise.allSettled([
        writeStorageBuffer(
          "_uploads",
          preparedImageKey,
          normalized.processed,
          contentType(normalized.ext),
          session.storage_slug,
          { signal: storageSignal }
        ),
        writeStorageBuffer(
          "_uploads",
          preparedThumbnailKey,
          normalized.thumbnail,
          "image/webp",
          session.storage_slug,
          { signal: storageSignal }
        )
      ]);
      const failure = writes.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      if (failure) throw failure.reason;
      storageSignal.throwIfAborted();
      current = await currentPreparingSession(repository, current);
      const duplicates = await captureIngestionDuplicateCheck(normalized.md5);
      return mutateIngestionExecution(
        repository,
        current,
        (latest) => {
          const nextWithoutHash = {
            ...latest,
            status: "ready" as const,
            phase: "ready",
            message: duplicates.check.match_count
              ? "处理完成，请确认重复图片"
              : "处理完成，可以提交",
            progress: 100,
            execution_token: "",
            raw_generation: "",
            raw_size: 0,
            prepared: {
              prepared_image_key: preparedImageKey,
              prepared_thumbnail_key: preparedThumbnailKey,
              original_size: normalized.sourceSize,
              original_width: normalized.sourceWidth,
              original_height: normalized.sourceHeight,
              width: normalized.width,
              height: normalized.height,
              ext: normalized.ext,
              md5: normalized.md5,
              prepared_image_sha256: sha256Buffer(normalized.processed),
              prepared_thumbnail_sha256: sha256Buffer(normalized.thumbnail),
              size: normalized.size,
              thumbnail_size: normalized.thumbnail.byteLength,
              quality: normalized.quality,
              transcoded: normalized.transcoded,
              detected_device: detectedDevice,
              detected_brightness: detectedBrightness,
              duplicate_count: duplicates.check.match_count,
              generation: preparedGeneration
            },
            error: undefined,
            semantic_hash: ""
          };
          return {
            ...nextWithoutHash,
            semantic_hash: ingestionSessionSemanticHash(nextWithoutHash)
          };
        }
      );
    });
  };

  const prepareAttempt = async () => {
    signal.throwIfAborted();
    const preparedSession = await withIngestionPreparationAdmission(
      signal,
      prepareAndPublish
    );
    await removeOwnedIngestionRaw(
      session.queue,
      session,
      session.raw_generation
    ).catch((error) => {
      logger.warn("ingestion_raw_cleanup_deferred", {
        session_id: session.session_id,
        image_id: session.image_id,
        error: errorMessage(error)
      });
    });
    return preparedSession;
  };

  try {
    return await withActiveIngestionRawPaths([rawPath], () => (
      runWithAdvisoryLockAcquisitionSignal(
        signal,
        prepareAttempt
      )
    ));
  } catch (error) {
    if (enteredStorageBoundary) {
      await cleanupPreparedAttempt(
        repository,
        session,
        session.storage_slug,
        preparedImageKey,
        preparedThumbnailKey
      );
    }
    throw error;
  }
}
