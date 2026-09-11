import { getIngestionMaxLongEdge } from "../../../config/app-settings.ts";
import { getRuntimeConfig } from "../../../config/runtime-config-store.ts";
import { ApiError, errorMessage } from "../../../core/api-error.ts";
import {
  runWithAdvisoryLockAcquisitionSignal
} from "../../../core/database/advisory-locks.ts";
import { logger } from "../../../core/logger.ts";
import { randomUuidV7 } from "../../../core/uuid.ts";
import { removeIngestionPreparedFiles, writeIngestionPreparedFile } from "../raw/prepared.ts";
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
import { removeOwnedIngestionRaw } from "../raw/files.ts";
import { withActiveIngestionTempPaths } from "../raw/lease-registry.ts";
import { ingestionRawPath, ingestionPreparedFile, ingestionPreparedPath } from "../raw/paths.ts";
import type {
  IngestionSessionSnapshot,
  StoredIngestionSession
} from "../sessions/model.ts";
import { ingestionSessionSemanticHash } from "../sessions/projection.ts";
import { IngestionSessionRepository } from "../repository.ts";
import { withIngestionPreparationAdmission } from "./preparation-admission.ts";

function requiredDeviceFromDimensions(width: number, height: number) {
  return deviceFromDimensions(width, height) ?? "pc";
}

export function preparedAttemptIsReferenced(
  current: StoredIngestionSession | null,
  expected: Pick<IngestionSessionSnapshot, "image_id">,
  imageFile: string,
  thumbnailFile: string
) {
  return Boolean(
    current
    && current.image_id === expected.image_id
    && "prepared" in current
    && current.prepared?.prepared_image_path === imageFile
    && current.prepared.prepared_thumbnail_path === thumbnailFile
  );
}

async function cleanupPreparedAttempt(
  repository: IngestionSessionRepository,
  session: IngestionSessionSnapshot,
  imageFile: string,
  thumbnailFile: string
) {
  const removeIfUnreferenced = async () => {
    const current = await repository.readSession(session.owner, session.session_id);
    // A semantic publish can succeed even when its response is lost. Preserve
    // the exact objects referenced by the canonical snapshot.
    if (preparedAttemptIsReferenced(
      current,
      session,
      imageFile,
      thumbnailFile
    )) return;
    await removeIngestionPreparedFiles([imageFile, thumbnailFile]);
  };
  try {
    await removeIfUnreferenced();
    return;
  } catch (error) {
    logger.warn("ingestion_prepared_attempt_cleanup_deferred", {
      session_id: session.session_id,
      image_id: session.image_id,
      error: errorMessage(error)
    });
  }
  // The retry re-reads Redis before every delete attempt. Unknown ownership
  // therefore remains fail-closed without losing the exact local file references.
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
  const attemptIdentity = {
    session_id: session.session_id,
    image_id: session.image_id,
    generation: preparedGeneration,
    execution_token: session.execution_token
  };
  const preparedImageFile = ingestionPreparedFile(attemptIdentity, "image");
  const preparedThumbnailFile = ingestionPreparedFile(attemptIdentity, "thumb");
  const rawPath = ingestionRawPath(
    session,
    session.raw_generation
  );
  const transcode = dependencies.transcode ?? transcodeStoredImage;
  let enteredLocalWrite = false;

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
        },
        signal
      );
      signal.throwIfAborted();
      current = await refreshIngestionExecutionSession(repository, current);
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
      current = await refreshIngestionExecutionSession(repository, current);
      return { normalized, detectedDevice, detectedBrightness };
    });
    const { normalized, detectedDevice, detectedBrightness } = normalizedState;
    current = await updateIngestionExecutionProgress(
      repository,
      current,
      {
        phase: "staging",
        message: "在本地保存处理结果和缩略图",
        progress: null
      }
    );
    signal.throwIfAborted();
    enteredLocalWrite = true;
    const writes = await Promise.allSettled([
      writeIngestionPreparedFile(preparedImageFile, normalized.processed, signal),
      writeIngestionPreparedFile(preparedThumbnailFile, normalized.thumbnail, signal)
    ]);
    const failure = writes.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failure) throw failure.reason;
    signal.throwIfAborted();
    current = await refreshIngestionExecutionSession(repository, current);
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
            prepared_image_path: preparedImageFile,
            prepared_thumbnail_path: preparedThumbnailFile,
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
  };

  const prepareAttempt = async () => {
    signal.throwIfAborted();
    const preparedSession = await withIngestionPreparationAdmission(
      signal,
      prepareAndPublish
    );
    await removeOwnedIngestionRaw(
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
    const paths = [rawPath, ...[preparedImageFile, preparedThumbnailFile].flatMap((file) => {
      const path = ingestionPreparedPath(file);
      return [path, path + ".part"];
    })];
    return await withActiveIngestionTempPaths(paths, () => (
      runWithAdvisoryLockAcquisitionSignal(
        signal,
        prepareAttempt
      )
    ));
  } catch (error) {
    if (enteredLocalWrite) {
      await cleanupPreparedAttempt(
        repository,
        session,
        preparedImageFile,
        preparedThumbnailFile
      );
    }
    throw error;
  }
}
